import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Pod } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createMockContainerManager,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { checkpointSandboxWorkspace } from '../worktrees/sandbox-workspace-checkpoint.js';
import { createPodRepository } from './pod-repository.js';
import {
  type CheckpointRecord,
  WorkspaceCheckpointController,
} from './workspace-checkpoint-controller.js';
import { createWorkspacePreservation } from './workspace-preservation.js';

const run = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, env: gitEnv, timeout: 5_000 })).stdout.trim();
}

/** Build a real snapshot, then close its database before exercising the module. */
function workspacePod(id: string, worktreePath: string): Pod {
  const db = createTestDb();
  try {
    insertTestProfile(db);
    const pods = createPodRepository(db);
    pods.insert({
      id,
      profileName: 'test-profile',
      task: 'Preserve source',
      status: 'failed',
      model: 'sonnet',
      runtime: 'claude',
      executionTarget: 'sandbox',
      branch: 'feature',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    pods.update(id, { containerId: 'sandbox-source', worktreePath });
    return pods.getOrThrow(id);
  } finally {
    db.close();
  }
}

describe('workspace preservation boundary', () => {
  it.each(['controller', 'direct'] as const)(
    'materializes actual dirty source through the %s checkpoint path',
    async (routing) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'autopod-preservation-'));
      try {
        const seed = path.join(root, 'seed');
        const host = path.join(root, 'host');
        const sandbox = path.join(root, 'sandbox');
        const containerTmp = path.join(root, 'container-tmp');
        await mkdir(containerTmp);
        await git(root, ['init', '--initial-branch=main', seed]);
        await writeFile(path.join(seed, 'tracked.txt'), 'baseline\n');
        await git(seed, ['add', '.']);
        await git(seed, ['commit', '-m', 'baseline']);
        await git(root, ['clone', seed, host]);
        await git(root, ['clone', seed, sandbox]);
        await git(host, ['checkout', '-b', 'feature']);
        await git(sandbox, ['checkout', '-b', 'feature']);
        await writeFile(path.join(sandbox, 'tracked.txt'), 'changed by the worker\n');
        await writeFile(path.join(sandbox, 'report.md'), '# Preserved report\n');
        const sourceHead = await git(sandbox, ['rev-parse', 'HEAD']);
        const sourceStatus = await git(sandbox, ['status', '--porcelain']);
        const pod = workspacePod(path.basename(root), host);
        const cm = createMockContainerManager();
        cm.execInContainer = vi.fn(async (_containerId, command) => {
          if (command[0] !== 'sh' || command[1] !== '-ceu' || !command[2])
            throw new Error('Unexpected checkpoint command');
          // Run the actual production shell script with only its two absolute
          // container directories mapped into this test's private filesystem.
          const script = command[2]
            .replaceAll('/tmp/', `${containerTmp}/`)
            .replace('cd /workspace', `cd '${sandbox.replaceAll("'", "'\\''")}'`);
          try {
            const output = await run('sh', ['-ceu', script], { env: gitEnv, timeout: 5_000 });
            return { stdout: output.stdout, stderr: output.stderr, exitCode: 0 };
          } catch (err) {
            const failure = err as { stdout?: string; stderr?: string; code?: number };
            return {
              stdout: failure.stdout ?? '',
              stderr: failure.stderr ?? String(err),
              exitCode: typeof failure.code === 'number' ? failure.code : 1,
            };
          }
        });
        const localPath = (remote: string) => {
          if (!remote.startsWith('/tmp/')) throw new Error('Unexpected checkpoint file');
          return path.join(containerTmp, path.basename(remote));
        };
        cm.readFile = vi.fn(async (_containerId, remote) => readFile(localPath(remote), 'utf8'));
        cm.readFileBinary = vi.fn(async (_containerId, remote) => readFile(localPath(remote)));
        const records: CheckpointRecord[] = [];
        const controller = new WorkspaceCheckpointController({
          observe: async () => ({
            head: await git(sandbox, ['rev-parse', 'HEAD']),
            tree: await git(sandbox, ['rev-parse', 'HEAD^{tree}']),
            dirty: (await git(sandbox, ['status', '--porcelain'])).length > 0,
          }),
          checkpoint: async (podId, _reason, sequence) =>
            checkpointSandboxWorkspace({
              containerManager: cm,
              containerId: 'sandbox-source',
              podId,
              worktreePath: host,
              sequence,
            }),
          records: {
            save: async (record) => {
              records.push(record);
            },
            latest: async () => records.at(-1) ?? null,
            latestVerified: async () => records.findLast((record) => !!record.verifiedAt) ?? null,
            incomplete: async () => records.filter((record) => !record.verifiedAt),
          },
          retryDelaysMs: [],
        });
        const activity = vi.fn();
        const sync = vi.fn(async () => {
          throw new Error('Unexpected local synchronization');
        });
        const preservation = createWorkspacePreservation({
          getContainerManager: () => cm,
          syncWorkspaceBack: sync,
          ...(routing === 'controller' && { workspaceCheckpointController: controller }),
          logger,
          emitActivityStatus: activity,
        });

        await preservation.preservePodWorkspace(pod, 'boundary test');
        const proof = await preservation.checkpointSandboxWorkspaceForPod(pod);

        expect(proof).toMatchObject({
          sourceHead,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          lineageVerified: true,
          promoted: true,
          materialized: true,
        });
        expect(proof.error).toBeUndefined();
        expect(await git(host, ['rev-parse', 'HEAD'])).toBe(proof.snapshotCommit);
        expect(await git(host, ['rev-parse', 'HEAD^{tree}'])).toBe(proof.snapshotTree);
        expect(await git(host, ['rev-parse', proof.quarantineRef])).toBe(proof.snapshotCommit);
        expect(await readFile(path.join(host, 'tracked.txt'), 'utf8')).toBe(
          'changed by the worker\n',
        );
        expect(await readFile(path.join(host, 'report.md'), 'utf8')).toBe('# Preserved report\n');
        expect(await git(host, ['status', '--porcelain'])).toBe('');
        expect(await git(sandbox, ['rev-parse', 'HEAD'])).toBe(sourceHead);
        expect(await git(sandbox, ['status', '--porcelain'])).toBe(sourceStatus);
        expect(activity).toHaveBeenCalledExactlyOnceWith(
          pod.id,
          'Verified workspace checkpoint before boundary test.',
        );
        expect(sync).not.toHaveBeenCalled();
        expect(cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
        expect(cm.kill).not.toHaveBeenCalled();
        expect(pod.status).toBe('failed');
        if (routing === 'controller') {
          expect(records.map((record) => record.sequence)).toEqual([1, 2]);
          expect(records[1]?.result).toBe(proof);
          expect(records.every((record) => record.verifiedAt !== null)).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(['containerId', 'worktreePath'] as const)(
    'returns the complete missing-workspace proof when %s is absent',
    async (missing) => {
      const pod = { ...workspacePod('missing-source', '/unused'), [missing]: null };
      const getContainerManager = vi.fn(() => createMockContainerManager());
      const preservation = createWorkspacePreservation({
        getContainerManager,
        syncWorkspaceBack: async () => ({ pushed: false }),
        logger,
        emitActivityStatus: vi.fn(),
      });

      await expect(preservation.checkpointSandboxWorkspaceForPod(pod)).resolves.toEqual({
        sequence: 0,
        sourceHead: '',
        sourceTree: '',
        snapshotCommit: '',
        snapshotTree: '',
        transferVerified: false,
        bundleVerified: false,
        hostImported: false,
        lineageVerified: false,
        promoted: false,
        materialized: false,
        quarantineRef: '',
        error: {
          phase: 'capture',
          code: 'NO_WORKSPACE',
          retryable: false,
          message: 'Sandbox pod has no container or Git worktree',
        },
      });
      expect(getContainerManager).not.toHaveBeenCalled();
    },
  );
});

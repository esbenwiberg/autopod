import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RecoveryForkInput, RecoveryForkRequest } from '@autopod/shared';
import { afterEach, expect, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { QUALIFICATION_SOURCE_PROBE } from '../pods/environment-qualification.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createPodManager } from '../pods/pod-manager.js';
import { recoveryGit } from '../worktrees/recovery-fork-source.js';
import { inspectSupplementalAdoptionGit } from '../worktrees/source-adoption-git.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from './retained-checkpoint-helpers.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
export const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  ).stdout.trim();
export async function fixture(
  noRequirements = false,
  originalHandoff?: string,
  dockerFixture?: { containerId: string; containerManager: ContainerManager },
) {
  const f = await retainedCheckpointFixture(
    'prevalidation',
    true,
    true,
    true,
    'local',
    noRequirements
      ? undefined
      : {
          version: 2,
          executables: ['node'],
          platform: 'linux/amd64',
        },
    undefined,
    originalHandoff,
  );
  fixtures.push(f);
  await materializeCheckpointFixture(f);
  if (dockerFixture) {
    const source = f.pod().worktreePath!;
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        scripts: { build: 'node --check source.ts', test: 'node --test continuation.test.mjs' },
      }),
    );
    await writeFile(
      path.join(source, 'continuation.test.mjs'),
      "import assert from 'node:assert/strict';\nimport * as source from './source.ts';\nassert.equal(source.preserved, true);\nassert.equal(source.continued, 'fresh pod');\n",
    );
    await git(source, 'add', 'package.json', 'continuation.test.mjs');
    await git(
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Synthetic failing continuation check',
    );
    f.input.checkpointHead = await git(source, 'rev-parse', 'HEAD');
  }
  f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => {
    const source = await inspectSupplementalAdoptionGit(recoveryGit(cwd), branch);
    return { branch, commitSha: source.head, treeSha: source.tree, worktreeClean: true };
  });
  const containerId = dockerFixture?.containerId ?? '1'.repeat(64);
  if (dockerFixture) {
    f.ctx.deps.containerManagerFactory.get = vi.fn(() => dockerFixture.containerManager);
  }
  f.ctx.podRepo.update(f.podId, {
    containerId,
    startCommitSha: f.input.checkpointHead,
    tokenBudget: 1000,
    inputTokens: 40,
    tokenTelemetryAccuracy: 'complete',
    phaseTokenUsage: {},
    validationAttempts: 1,
  });
  f.ctx.podRepo.completionJournal!.settle(f.pod(), 'Visible implementation failed during checks');
  f.ctx.podRepo.completionJournal!.mark(f.pod(), 'ready', true);
  const run = f.ctx.podRepo.taskExecutions!.beginRun(
    f.podId,
    f.pod().lifecycleGeneration,
    f.pod().finalization!.cycle,
    {
      runtime: f.pod().runtime,
      model: f.pod().model,
      providerAccountId: 'account',
      resource: { containerId, executionTarget: 'local' },
    },
  );
  f.ctx.podRepo.taskExecutions!.finishRun(run, 'completed', null);
  f.ctx.podRepo.workerRetries!.state(f.podId); // Historical import is explicit fixture setup, never GET/preview.
  f.cm.getResourceKey = vi.fn(async (id) => JSON.stringify(['docker', 'fixture', id]));
  f.cm.getStatus = vi.fn(async (id) => (id === containerId ? 'stopped' : 'running'));
  f.ctx.deps.eventRepo = createEventRepository(f.ctx.db);
  const launch = f.ctx.deps.launchConfiguration!;
  const snapshots = createLaunchSnapshotRepository(f.ctx.db, createConfigurationStore(f.ctx.db));
  launch.admitRecoveryFork = async (id, createPod, initializePod) =>
    f.ctx.podRepo.atomically!(() => {
      launch.assertRecoveryAdmissionReady!();
      return snapshots.admitRecoveryFork(id, createPod, initializePod);
    });
  launch.assertRecoveryAdmissionReady = () => {};
  launch.availableRecoveryProfiles = () => [{ id: 'profile', label: 'Development' }];
  vi.stubEnv('DATA_DIR', f.root);
  vi.stubEnv('AUTOPOD_CLAUDE_STATE_DIR', path.join(f.root, 'claude-state'));
  vi.stubEnv('AUTOPOD_CODEX_STATE_DIR', path.join(f.root, 'codex-state'));
  const manager = createPodManager(f.ctx.deps);
  const input: RecoveryForkInput = {
    version: 1,
    expectedGeneration: f.pod().lifecycleGeneration,
    sourceHead: f.input.checkpointHead,
    executionProfileId: '@original',
    instructions:
      'Continue the original task; investigate the failing checks and retain all prior work.',
    files: [],
    acknowledgePartialSource: true,
  };
  async function request(): Promise<RecoveryForkRequest> {
    const preview = await manager.previewRecoveryFork(f.podId, input);
    expect(preview.blockers).toEqual([]);
    expect(preview.available).toBe(true);
    return { ...input, id: 'human-request', expectedBinding: preview.expectedBinding! };
  }
  return { ...f, manager, input, request, containerId, snapshots, launch };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

export function codingTransport(
  f: Awaited<ReturnType<typeof fixture>>,
  outcome: 'qualified' | 'failed' | 'unknown' = 'qualified',
  parentPodId = f.podId,
  candidateId = '2'.repeat(64),
) {
  const image = `sha256:${'a'.repeat(64)}`;
  f.launch.prepareEnvironment = vi.fn(async () => image);
  f.cm.supportsStreamingExec = true;
  f.cm.spawn = vi.fn(async () => candidateId);
  f.cm.getExecutionMetadata = vi.fn(async () => ({
    imageDigest: image,
    memoryLimitBytes: outcome === 'failed' ? 1024 : 2 * 1024 ** 3,
    cpuLimit: 1,
    networkMode: 'isolated',
  }));
  const read = f.cm.readFile.bind(f.cm);
  f.cm.readFile = vi.fn(async (id, file) =>
    file === '/autopod/recovery/handoff.json'
      ? readFile(f.ctx.podRepo.recoveryForks!.parent(parentPodId)!.facts.prepared!.packet, 'utf8')
      : read(id, file),
  );
  const execute = f.cm.execInContainer.bind(f.cm);
  f.cm.execInContainer = vi.fn(async (id, command, options) => {
    if (command[2]?.includes('autopod-validation-source-v1')) {
      const p = f.ctx.podRepo.recoveryForks!.parent(parentPodId)!.facts.prepared!;
      try {
        const result = await exec(
          '/usr/bin/git',
          command.slice(command.indexOf('/usr/bin/git') + 3),
          {
            cwd: p.worktree,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
          },
        );
        return { ...result, exitCode: 0 };
      } catch {
        return { exitCode: 1, stdout: '', stderr: 'Actual candidate source unavailable' };
      }
    }
    if (command[2] === QUALIFICATION_SOURCE_PROBE) {
      if (outcome === 'unknown') return { exitCode: 1, stdout: '', stderr: 'Unverified probe' };
      const p = f.ctx.podRepo.recoveryForks!.parent(parentPodId)!.facts.prepared!;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          platform: 'linux/amd64',
          uid: 1000,
          cwd: '/workspace',
          head: await git(p.worktree, 'rev-parse', 'HEAD'),
          tree: await git(p.worktree, 'rev-parse', 'HEAD^{tree}'),
          clean: (await git(p.worktree, 'status', '--porcelain')) === '',
          baseAncestor: true,
        }),
        stderr: '',
      };
    }
    if (command.includes('--version')) return { exitCode: 0, stdout: 'claude 2.0.1', stderr: '' };
    if (command[2]?.includes('autopod-command-preflight-v1')) {
      const names = JSON.parse(command[3] ?? '[]') as string[];
      return {
        exitCode: 0,
        stdout: JSON.stringify(names.map((executable) => ({ executable, available: true }))),
        stderr: '',
      };
    }
    if (command[2] === 'command -v claude')
      return { exitCode: 0, stdout: '/usr/local/bin/claude', stderr: '' };
    return execute(id, command, options);
  });
  return { candidateId, image };
}

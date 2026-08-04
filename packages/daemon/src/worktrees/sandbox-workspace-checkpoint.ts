import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ContainerManager } from '../interfaces/container-manager.js';

const execFileAsync = promisify(execFile);

/** Proof returned by sandbox source delivery.  Do not collapse this to a success boolean. */
export interface WorkspaceCheckpointResult {
  sequence: number;
  sourceHead: string;
  sourceTree: string;
  snapshotCommit: string;
  snapshotTree: string;
  transferVerified: boolean;
  bundleVerified: boolean;
  hostImported: boolean;
  lineageVerified: boolean;
  promoted: boolean;
  materialized: boolean;
  quarantineRef: string;
  error?: { phase: string; code: string; retryable: boolean; message: string };
}

function empty(sequence: number, message: string, phase = 'capture'): WorkspaceCheckpointResult {
  return {
    sequence,
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
    error: { phase, code: 'CHECKPOINT_FAILED', retryable: true, message },
  };
}

/**
 * Capture a sandbox workspace using a private Git index, then import it into a
 * quarantine ref before atomically updating the linked worktree branch. The
 * sandbox bundle is the only source bytes read by this routine.
 */
export async function checkpointSandboxWorkspace(args: {
  containerManager: ContainerManager;
  containerId: string;
  podId: string;
  worktreePath: string;
  sequence: number;
}): Promise<WorkspaceCheckpointResult> {
  const { containerManager: cm, containerId, podId, worktreePath, sequence } = args;
  const token = podId.replace(/[^A-Za-z0-9_-]/g, '_');
  const remoteBundle = `/tmp/.autopod-checkpoint-${token}-${sequence}.bundle`;
  const remoteMeta = `${remoteBundle}.meta`;
  try {
    const capture = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-ceu',
        [
          'cd /workspace',
          'head=$(git rev-parse HEAD)',
          'tree=$(git rev-parse HEAD^{tree})',
          'idx=$(mktemp /tmp/autopod-index.XXXXXX)',
          'trap "rm -f $idx" EXIT',
          'GIT_INDEX_FILE=$idx git read-tree HEAD',
          // The index is daemon-owned: this never changes the agent index or HEAD.
          'GIT_INDEX_FILE=$idx git -c core.hooksPath=/dev/null add -A -- .',
          'snapshot_tree=$(GIT_INDEX_FILE=$idx git write-tree)',
          "snapshot=$(printf 'autopod sandbox checkpoint\\n' | GIT_AUTHOR_NAME=Autopod GIT_AUTHOR_EMAIL=autopod@localhost GIT_COMMITTER_NAME=Autopod GIT_COMMITTER_EMAIL=autopod@localhost git commit-tree $snapshot_tree -p $head)",
          `git update-ref refs/autopod-checkpoints/${token} "$snapshot"`,
          `git bundle create ${remoteBundle} "$snapshot"`,
          `printf '%s\\n%s\\n%s\\n%s\\n' "$head" "$tree" "$snapshot" "$snapshot_tree" > ${remoteMeta}`,
        ].join('; '),
      ],
      { timeout: 120_000 },
    );
    if (capture.exitCode !== 0) return empty(sequence, capture.stderr || 'snapshot capture failed');
    const [sourceHead, sourceTree, snapshotCommit, snapshotTree] = (
      await cm.readFile(containerId, remoteMeta)
    )
      .trim()
      .split('\n');
    if (!sourceHead || !sourceTree || !snapshotCommit || !snapshotTree)
      return empty(sequence, 'checkpoint metadata was incomplete');
    const bundle = await cm.readFileBinary(containerId, remoteBundle);
    const hash = createHash('sha256').update(bundle).digest('hex');
    if (!hash) return empty(sequence, 'checkpoint transfer hash failed', 'transfer');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'autopod-checkpoint-'));
    const bundlePath = path.join(temp, 'checkpoint.bundle');
    try {
      await writeFile(bundlePath, bundle, { mode: 0o600 });
      const common = (
        await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath })
      ).stdout.trim();
      const bare = path.resolve(worktreePath, common);
      await execFileAsync('git', ['bundle', 'verify', bundlePath], { cwd: bare });
      const quarantineRef = `refs/autopod-quarantine/${token}/${sequence}`;
      await execFileAsync('git', ['fetch', bundlePath, `${snapshotCommit}:${quarantineRef}`], {
        cwd: bare,
      });
      const importedTree = (
        await execFileAsync('git', ['rev-parse', `${quarantineRef}^{tree}`], { cwd: bare })
      ).stdout.trim();
      const parent = (
        await execFileAsync('git', ['rev-parse', `${quarantineRef}^`], { cwd: bare })
      ).stdout.trim();
      if (importedTree !== snapshotTree || parent !== sourceHead) {
        return {
          ...empty(sequence, 'checkpoint lineage did not match metadata', 'lineage'),
          sourceHead,
          sourceTree,
          snapshotCommit,
          snapshotTree,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          quarantineRef,
        };
      }
      const branch = (
        await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: worktreePath })
      ).stdout.trim();
      const expected = (
        await execFileAsync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: bare })
      ).stdout.trim();
      // A checkpoint is parented to the sandbox source HEAD.  Do not overwrite
      // host work that advanced independently while the bundle was in flight.
      if (expected !== sourceHead) {
        return {
          ...empty(sequence, 'feature branch moved since checkpoint capture', 'promotion'),
          sourceHead,
          sourceTree,
          snapshotCommit,
          snapshotTree,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          lineageVerified: true,
          quarantineRef,
          error: {
            phase: 'promotion',
            code: 'LINEAGE_CONFLICT',
            retryable: false,
            message: 'feature branch moved since checkpoint capture',
          },
        };
      }
      await execFileAsync('git', ['update-ref', `refs/heads/${branch}`, snapshotCommit, expected], {
        cwd: bare,
      });
      try {
        await execFileAsync('git', ['reset', '--hard', snapshotCommit], { cwd: worktreePath });
        const finalHead = (
          await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
        ).stdout.trim();
        const finalTree = (
          await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath })
        ).stdout.trim();
        const clean =
          (
            await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath })
          ).stdout.trim() === '';
        if (finalHead !== snapshotCommit || finalTree !== snapshotTree || !clean) {
          // Promotion is reversible until materialization proves the linked
          // worktree matches. Guard the rollback so concurrent host work wins.
          await execFileAsync(
            'git',
            ['update-ref', `refs/heads/${branch}`, sourceHead, snapshotCommit],
            {
              cwd: bare,
            },
          );
          await execFileAsync('git', ['reset', '--hard', sourceHead], { cwd: worktreePath });
          return {
            ...empty(sequence, 'host materialization verification failed', 'materialize'),
            sourceHead,
            sourceTree,
            snapshotCommit,
            snapshotTree,
            transferVerified: true,
            bundleVerified: true,
            hostImported: true,
            lineageVerified: true,
            promoted: false,
            quarantineRef,
          };
        }
        return {
          sequence,
          sourceHead,
          sourceTree,
          snapshotCommit,
          snapshotTree,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          lineageVerified: true,
          promoted: true,
          materialized: true,
          quarantineRef,
        };
      } catch (err) {
        // If reset itself fails, return the branch only if it is still ours.
        await execFileAsync(
          'git',
          ['update-ref', `refs/heads/${branch}`, sourceHead, snapshotCommit],
          {
            cwd: bare,
          },
        ).catch(() => {});
        return {
          ...empty(sequence, err instanceof Error ? err.message : String(err), 'materialize'),
          sourceHead,
          sourceTree,
          snapshotCommit,
          snapshotTree,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          lineageVerified: true,
          quarantineRef,
          error: {
            phase: 'materialize',
            code: 'MATERIALIZATION_FAILED',
            retryable: false,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } catch (err) {
    return empty(sequence, err instanceof Error ? err.message : String(err));
  }
}

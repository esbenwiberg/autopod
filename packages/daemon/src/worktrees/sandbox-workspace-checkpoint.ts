import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ContainerManager } from '../interfaces/container-manager.js';

const execFileAsync = promisify(execFile);

const CHECKPOINT_SUBJECT = 'autopod sandbox checkpoint';
const CHECKPOINT_ACTOR = 'Autopod';
const CHECKPOINT_EMAIL = 'autopod@localhost';

async function peelDaemonNoopCheckpoints(bare: string, tip: string): Promise<string> {
  let current = tip;
  for (let depth = 0; depth < 64; depth++) {
    const metadata = (
      await execFileAsync(
        'git',
        ['show', '-s', '--format=%s%x00%an%x00%ae%x00%cn%x00%ce', current],
        { cwd: bare },
      )
    ).stdout
      .trim()
      .split('\0');
    if (
      metadata.length !== 5 ||
      metadata[0] !== CHECKPOINT_SUBJECT ||
      metadata[1] !== CHECKPOINT_ACTOR ||
      metadata[2] !== CHECKPOINT_EMAIL ||
      metadata[3] !== CHECKPOINT_ACTOR ||
      metadata[4] !== CHECKPOINT_EMAIL
    ) {
      break;
    }

    const lineage = (
      await execFileAsync('git', ['rev-list', '--parents', '-n', '1', current], { cwd: bare })
    ).stdout
      .trim()
      .split(/\s+/);
    if (lineage.length !== 2 || !lineage[1]) break;
    const parent = lineage[1];
    const [currentTree, parentTree] = await Promise.all([
      execFileAsync('git', ['rev-parse', `${current}^{tree}`], { cwd: bare }),
      execFileAsync('git', ['rev-parse', `${parent}^{tree}`], { cwd: bare }),
    ]);
    if (currentTree.stdout.trim() !== parentTree.stdout.trim()) break;
    current = parent;
  }
  return current;
}

async function checkpointLineageBase(
  bare: string,
  expected: string,
  podToken: string,
): Promise<string> {
  const noOpBase = await peelDaemonNoopCheckpoints(bare, expected);
  if (noOpBase !== expected) return noOpBase;

  // A verified periodic checkpoint can contain real uncommitted work. The live
  // sandbox keeps its own HEAD, so its next snapshot is a sibling of that host
  // checkpoint rather than a descendant. Supersede only an exact commit already
  // retained under this pod's host-owned quarantine namespace; lookalike commits
  // and checkpoints imported for another pod remain divergence barriers.
  const quarantineRef = (
    await execFileAsync(
      'git',
      [
        'for-each-ref',
        '--format=%(refname)',
        '--points-at',
        expected,
        `refs/autopod-quarantine/${podToken}/`,
      ],
      { cwd: bare },
    )
  ).stdout.trim();
  if (!quarantineRef) return expected;

  const metadata = (
    await execFileAsync(
      'git',
      ['show', '-s', '--format=%s%x00%an%x00%ae%x00%cn%x00%ce', expected],
      { cwd: bare },
    )
  ).stdout
    .trim()
    .split('\0');
  if (
    metadata.length !== 5 ||
    metadata[0] !== CHECKPOINT_SUBJECT ||
    metadata[1] !== CHECKPOINT_ACTOR ||
    metadata[2] !== CHECKPOINT_EMAIL ||
    metadata[3] !== CHECKPOINT_ACTOR ||
    metadata[4] !== CHECKPOINT_EMAIL
  ) {
    return expected;
  }

  const lineage = (
    await execFileAsync('git', ['rev-list', '--parents', '-n', '1', expected], { cwd: bare })
  ).stdout
    .trim()
    .split(/\s+/);
  return lineage.length === 2 && lineage[1] ? lineage[1] : expected;
}

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
export interface SandboxWorkspaceCheckpointArgs {
  containerManager: ContainerManager;
  containerId: string;
  podId: string;
  worktreePath: string;
  sequence: number;
}

export async function checkpointSandboxWorkspace(
  args: SandboxWorkspaceCheckpointArgs,
): Promise<WorkspaceCheckpointResult> {
  const { containerManager: cm, containerId, podId, worktreePath, sequence } = args;
  const token = podId.replace(/[^A-Za-z0-9_-]/g, '_');
  const checkpointRef = `refs/autopod-checkpoints/${token}`;
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
          `git update-ref ${checkpointRef} "$snapshot"`,
          // Bundles must advertise a named ref; a raw commit ID produces an empty bundle.
          `git bundle create ${remoteBundle} ${checkpointRef}`,
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
      await execFileAsync('git', ['fetch', bundlePath, `${checkpointRef}:${quarantineRef}`], {
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
      // The isolated sandbox normally advances beyond the host branch while the
      // agent works. A prior capture can leave a daemon checkpoint as the host
      // tip while the live sandbox advances independently from its parent. Peel
      // only a safe no-op or an exact prior quarantine commit for this pod;
      // arbitrary host commits remain divergence barriers.
      const expectedLineageBase = await checkpointLineageBase(bare, expected, token);
      const fastForward = await execFileAsync(
        'git',
        ['merge-base', '--is-ancestor', expectedLineageBase, sourceHead],
        { cwd: bare },
      ).then(
        () => true,
        () => false,
      );
      if (!fastForward) {
        return {
          ...empty(sequence, 'feature branch diverged from checkpoint source', 'promotion'),
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
            message: 'feature branch diverged from checkpoint source',
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
            ['update-ref', `refs/heads/${branch}`, expected, snapshotCommit],
            {
              cwd: bare,
            },
          );
          await execFileAsync('git', ['reset', '--hard', expected], { cwd: worktreePath });
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
          ['update-ref', `refs/heads/${branch}`, expected, snapshotCommit],
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

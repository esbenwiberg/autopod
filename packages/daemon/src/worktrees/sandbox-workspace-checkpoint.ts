import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorkspaceFingerprint } from '../pods/workspace-checkpoint-controller.js';
import { inspectAdoptionGit, safeAdoptionGit } from './source-adoption-git.js';

const execFileAsync = promisify(execFile);

const CHECKPOINT_SUBJECT = 'autopod sandbox checkpoint';
const CHECKPOINT_ACTOR = 'Autopod';
const CHECKPOINT_EMAIL = 'autopod@localhost';

function hostGit(cwd: string, timeout = 15_000) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return safeAdoptionGit(async (args) => {
    const result = await execFileAsync('git', args, {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_GRAFT_FILE: '/dev/null',
      },
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    });
    // Git -z paths are raw bytes. Reject non-UTF-8 rather than probing a different
    // filesystem path after Node silently substitutes replacement characters.
    return {
      stdout: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout),
      stderr: result.stderr.toString('utf8'),
    };
  });
}

async function peelDaemonNoopCheckpoints(bare: string, tip: string): Promise<string> {
  const git = hostGit(bare);
  let current = tip;
  for (let depth = 0; depth < 64; depth++) {
    const metadata = (
      await git(['show', '-s', '--format=%s%x00%an%x00%ae%x00%cn%x00%ce', current])
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

    const lineage = (await git(['rev-list', '--parents', '-n', '1', current])).stdout
      .trim()
      .split(/\s+/);
    if (lineage.length !== 2 || !lineage[1]) break;
    const parent = lineage[1];
    const [currentTree, parentTree] = await Promise.all([
      git(['rev-parse', `${current}^{tree}`]),
      git(['rev-parse', `${parent}^{tree}`]),
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

  return (await quarantinedCheckpointSourceHead(bare, expected, podToken)) ?? expected;
}

async function quarantinedCheckpointSourceHead(
  bare: string,
  checkpoint: string,
  podToken: string,
): Promise<string | null> {
  // A verified periodic checkpoint can contain real uncommitted work. The live
  // sandbox keeps its own HEAD, so its next snapshot is a sibling of that host
  // checkpoint rather than a descendant. Supersede only an exact commit already
  // retained under this pod's host-owned quarantine namespace; lookalike commits
  // and checkpoints imported for another pod remain divergence barriers.
  const git = hostGit(bare);
  const namespace = `refs/autopod-quarantine/${podToken}/`;
  const refs = (
    await git(['for-each-ref', '--format=%(refname)', '--points-at', checkpoint, namespace])
  ).stdout
    .trim()
    .split('\n');
  // Only a verified original commit gets a -committed custody ref.
  if (
    refs.some(
      (ref) => ref.startsWith(namespace) && /^\d+-committed$/.test(ref.slice(namespace.length)),
    )
  )
    return checkpoint;
  if (!refs.some((ref) => ref.startsWith(namespace) && /^\d+$/.test(ref.slice(namespace.length))))
    return null;

  // Raw headers, rather than revision-walker parents: replace refs/grafts must
  // not turn another commit into owned single-parent checkpoint evidence.
  const raw = (await git(['cat-file', 'commit', checkpoint])).stdout;
  const separator = raw.indexOf('\n\n');
  const headers = raw.slice(0, separator).split('\n');
  const parents = headers.filter((line) => line.startsWith('parent '));
  if (
    separator < 0 ||
    raw.slice(separator + 2).split('\n')[0] !== CHECKPOINT_SUBJECT ||
    !headers.some((line) =>
      /^author Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line),
    ) ||
    !headers.some((line) =>
      /^committer Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line),
    ) ||
    parents.length !== 1
  )
    return null;
  return parents[0]?.slice(7) ?? null;
}

/**
 * Resolve the live sandbox source commit behind an exact host-owned checkpoint.
 * Merely matching the checkpoint author/subject is insufficient: the commit must
 * still be retained under this pod's quarantine namespace.
 */
export async function resolveSandboxCheckpointSourceHead(
  worktreePath: string,
  podId: string,
  checkpoint: string,
): Promise<string | null> {
  const token = podId.replace(/[^A-Za-z0-9_-]/g, '_');
  const common = (await hostGit(worktreePath)(['rev-parse', '--git-common-dir'])).stdout.trim();
  const bare = path.resolve(worktreePath, common);
  return quarantinedCheckpointSourceHead(bare, checkpoint, token);
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
  /** Both old and new source remain retained in this pod's quarantine. */
  rewrittenFrom?: { checkpoint: string; sourceHead: string; base: string };
  error?: { phase: string; code: string; retryable: boolean; message: string };
}

async function inspectUnpublishedRewrite(input: {
  bare: string;
  worktreePath: string;
  branch: string;
  expected: string;
  sourceHead: string;
  snapshotCommit: string;
  podToken: string;
  base: string;
}): Promise<WorkspaceCheckpointResult['rewrittenFrom']> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.base)) return;
  const git = hostGit(input.worktreePath);
  try {
    // Only an exact pod-owned checkpoint can be superseded. Never peel arbitrary
    // host commits, even no-op commits that imitate checkpoint metadata.
    const previousSource = await quarantinedCheckpointSourceHead(
      input.bare,
      input.expected,
      input.podToken,
    );
    if (!previousSource) return;
    const source = await inspectAdoptionGit(git, input.branch);
    if (source.head !== input.expected) return;
    await git(['merge-base', '--is-ancestor', input.base, previousSource]);
    await git(['merge-base', '--is-ancestor', input.base, input.sourceHead]);
    if (/^160000 /m.test((await git(['ls-tree', '-r', input.snapshotCommit])).stdout)) return;
    // A clean worktree may still contain ignored reports. Do not overwrite an
    // existing file/directory if the rewritten source starts tracking that path.
    const added = (
      await git([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--name-only',
        '--diff-filter=A',
        '-z',
        input.expected,
        input.snapshotCommit,
        '--',
      ])
    ).stdout
      .split('\0')
      .filter(Boolean);
    for (const file of added) {
      const parts = file.split('/');
      if (parts.some((part) => !part || part === '.' || part === '..')) return;
      let target = input.worktreePath;
      for (const [index, part] of parts.entries()) {
        target = path.join(target, part);
        const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!entry) break;
        // Never follow an ignored symlink ancestor (including a dangling one).
        // Existing ordinary directories may contain unrelated retained reports.
        if (!entry.isDirectory() || index === parts.length - 1) return;
      }
    }
    const after = await inspectAdoptionGit(git, input.branch);
    if (after.head !== source.head || after.tree !== source.tree) return;
    if (
      (await quarantinedCheckpointSourceHead(input.bare, input.expected, input.podToken)) !==
      previousSource
    )
      return;
    return { checkpoint: input.expected, sourceHead: previousSource, base: input.base };
  } catch {
    // Missing/uncertain proof is still a lineage conflict, never retry authority.
    return;
  }
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

const WORKSPACE_FINGERPRINT_SCRIPT = [
  'cd /workspace',
  'git rev-parse HEAD',
  // Hash contents, not just paths: a second edit to an already-dirty file must change the
  // fingerprint, otherwise it is neither re-checkpointed nor reported as unprotected.
  // Plain `git hash-object` (no -w) and `git diff` never write the object store or index.
  '{ git status --porcelain=v1 -uall -z; git diff --binary --no-ext-diff --no-textconv HEAD --; git ls-files -z --others --exclude-standard | xargs -0 -r git hash-object --; } | git hash-object --stdin',
  'test -n "$(git status --porcelain=v1 -uall)" && echo dirty || echo clean',
].join('; ');

/** Observe the live sandbox workspace without writing to its index or object store. */
export async function observeSandboxWorkspace(
  cm: ContainerManager,
  containerId: string,
  assertCurrent: () => void,
): Promise<WorkspaceFingerprint> {
  assertCurrent();
  const output = await cm.execInContainer(
    containerId,
    ['sh', '-ceu', WORKSPACE_FINGERPRINT_SCRIPT],
    {
      timeout: 15_000,
      assertCurrent,
    },
  );
  assertCurrent();
  if (output.exitCode !== 0)
    throw new Error(`sandbox workspace fingerprint failed: ${output.stderr.trim()}`);
  const [head = '', tree = '', state = 'clean'] = output.stdout.trim().split('\n');
  return { head, tree, dirty: state === 'dirty' };
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
  assertCurrent: () => void;
  /** Frozen admitted base, supplied only for first-generation unpublished work. */
  unpublishedSourceBase?: string;
}

export async function checkpointSandboxWorkspace(
  args: SandboxWorkspaceCheckpointArgs,
): Promise<WorkspaceCheckpointResult> {
  const { containerManager: cm, containerId, podId, worktreePath, sequence, assertCurrent } = args;
  const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await operation();
    assertCurrent();
    return value;
  };
  assertCurrent();
  const token = podId.replace(/[^A-Za-z0-9_-]/g, '_');
  const checkpointRef = `refs/autopod-checkpoints/${token}`;
  const remoteBundle = `/tmp/.autopod-checkpoint-${token}-${sequence}.bundle`;
  const remoteMeta = `${remoteBundle}.meta`;
  try {
    const capture = await owned(() =>
      cm.execInContainer(
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
            // Rework captures the stopped sandbox again before replacing it. Reuse
            // identical source/tree snapshots: a timestamp-only sibling would rewind
            // a branch that was already published and make its next push non-fast-forward.
            `snapshot=$(git rev-parse --verify ${checkpointRef}^{commit} 2>/dev/null || true)`,
            // Clean work needs a custody ref, not a new commit. Keep the
            // sandbox, review packet and host worktree on the exact same HEAD.
            'if [ "$snapshot_tree" = "$tree" ]; then snapshot=$head; ' +
              'elif [ -z "$snapshot" ] || [ "$(git rev-list --parents -n 1 "$snapshot" 2>/dev/null || true)" != "$snapshot $head" ] || [ "$(git rev-parse "$snapshot^{tree}" 2>/dev/null || true)" != "$snapshot_tree" ]; then ' +
              "snapshot=$(printf 'autopod sandbox checkpoint\\n' | GIT_AUTHOR_NAME=Autopod GIT_AUTHOR_EMAIL=autopod@localhost GIT_COMMITTER_NAME=Autopod GIT_COMMITTER_EMAIL=autopod@localhost git commit-tree $snapshot_tree -p $head); fi",
            `git update-ref ${checkpointRef} "$snapshot"`,
            // Bundles must advertise a named ref; a raw commit ID produces an empty bundle.
            `git bundle create ${remoteBundle} ${checkpointRef}`,
            `printf '%s\\n%s\\n%s\\n%s\\n' "$head" "$tree" "$snapshot" "$snapshot_tree" > ${remoteMeta}`,
          ].join('; '),
        ],
        { timeout: 120_000, assertCurrent },
      ),
    );
    if (capture.exitCode !== 0) return empty(sequence, capture.stderr || 'snapshot capture failed');
    const [sourceHead, sourceTree, snapshotCommit, snapshotTree] = (
      await owned(() => cm.readFile(containerId, remoteMeta))
    )
      .trim()
      .split('\n');
    if (
      !sourceHead ||
      !sourceTree ||
      !snapshotCommit ||
      !snapshotTree ||
      ![sourceHead, sourceTree, snapshotCommit, snapshotTree].every((value) =>
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value),
      )
    )
      return empty(sequence, 'checkpoint metadata was incomplete');
    const bundle = await owned(() => cm.readFileBinary(containerId, remoteBundle));
    const hash = createHash('sha256').update(bundle).digest('hex');
    if (!hash) return empty(sequence, 'checkpoint transfer hash failed', 'transfer');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'autopod-checkpoint-'));
    const bundlePath = path.join(temp, 'checkpoint.bundle');
    try {
      await writeFile(bundlePath, bundle, { mode: 0o600 });
      const common = (
        await owned(() => hostGit(worktreePath)(['rev-parse', '--git-common-dir']))
      ).stdout.trim();
      const bare = path.resolve(worktreePath, common);
      const git = hostGit(bare);
      await owned(() => git(['bundle', 'verify', bundlePath]));
      const importedRef = `refs/autopod-quarantine/${token}/${sequence}`;
      await owned(() =>
        hostGit(bare, 120_000)(['fetch', bundlePath, `${checkpointRef}:${importedRef}`]),
      );
      const importedHead = (
        await owned(() => git(['rev-parse', `${importedRef}^{commit}`]))
      ).stdout.trim();
      const actualSourceTree = (
        await owned(() => git(['rev-parse', `${sourceHead}^{tree}`]))
      ).stdout.trim();
      const importedTree = (
        await owned(() => git(['rev-parse', `${importedRef}^{tree}`]))
      ).stdout.trim();
      const committed = snapshotCommit === sourceHead;
      const lineageMatches = committed
        ? snapshotTree === sourceTree
        : (
            await owned(() => git(['rev-list', '--parents', '-n', '1', importedHead]))
          ).stdout.trim() === `${importedHead} ${sourceHead}`;
      if (
        importedHead !== snapshotCommit ||
        importedTree !== snapshotTree ||
        !lineageMatches ||
        actualSourceTree !== sourceTree
      ) {
        return {
          ...empty(sequence, 'checkpoint lineage did not match metadata', 'lineage'),
          sourceHead,
          sourceTree,
          snapshotCommit,
          snapshotTree,
          transferVerified: true,
          bundleVerified: true,
          hostImported: true,
          quarantineRef: importedRef,
        };
      }
      const quarantineRef = committed ? `${importedRef}-committed` : importedRef;
      if (committed)
        await owned(() =>
          git(['update-ref', quarantineRef, importedHead, '0'.repeat(importedHead.length)]),
        );
      const branch = (
        await owned(() => hostGit(worktreePath)(['symbolic-ref', '--short', 'HEAD']))
      ).stdout.trim();
      const expected = (
        await owned(() => git(['rev-parse', `refs/heads/${branch}`]))
      ).stdout.trim();
      // The isolated sandbox normally advances beyond the host branch while the
      // agent works. A prior capture can leave a daemon checkpoint as the host
      // tip while the live sandbox advances independently from its parent. Peel
      // only a safe no-op or an exact prior quarantine commit for this pod;
      // arbitrary host commits remain divergence barriers.
      const expectedLineageBase = await owned(() => checkpointLineageBase(bare, expected, token));
      const fastForward = await owned(() =>
        git(['merge-base', '--is-ancestor', expectedLineageBase, sourceHead]),
      ).then(
        () => true,
        () => false,
      );
      const unpublishedSourceBase = args.unpublishedSourceBase;
      // Older releases may already have published a synthetic child of this
      // exact HEAD. Do not rewind that tip just to normalize its checkpoint.
      const legacyRewind =
        committed && expected !== sourceHead && expectedLineageBase === sourceHead;
      let allowLegacyRewind = !legacyRewind;
      if (legacyRewind && unpublishedSourceBase) {
        const ownedCheckpoint =
          (await owned(() => quarantinedCheckpointSourceHead(bare, expected, token))) ===
          sourceHead;
        if (ownedCheckpoint)
          allowLegacyRewind = await owned(() =>
            git(['merge-base', '--is-ancestor', unpublishedSourceBase, sourceHead]),
          ).then(
            () => true,
            () => false,
          );
      }
      const rewrittenFrom =
        !fastForward && unpublishedSourceBase
          ? await owned(() =>
              inspectUnpublishedRewrite({
                bare,
                worktreePath,
                branch,
                expected,
                sourceHead,
                snapshotCommit,
                podToken: token,
                base: unpublishedSourceBase,
              }),
            )
          : undefined;
      if ((!fastForward && !rewrittenFrom) || !allowLegacyRewind) {
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
            message: !allowLegacyRewind
              ? 'Existing checkpoint tip cannot be rewound without unpublished source custody'
              : 'feature branch diverged from checkpoint source',
          },
        };
      }
      await owned(() => git(['update-ref', `refs/heads/${branch}`, snapshotCommit, expected]));
      try {
        await owned(() => hostGit(worktreePath)(['reset', '--hard', snapshotCommit]));
        const finalHead = (
          await owned(() => hostGit(worktreePath)(['rev-parse', 'HEAD']))
        ).stdout.trim();
        const finalTree = (
          await owned(() => hostGit(worktreePath)(['rev-parse', 'HEAD^{tree}']))
        ).stdout.trim();
        const clean =
          (await owned(() => hostGit(worktreePath)(['status', '--porcelain']))).stdout.trim() ===
          '';
        if (finalHead !== snapshotCommit || finalTree !== snapshotTree || !clean) {
          // Promotion is reversible until materialization proves the linked
          // worktree matches. Guard the rollback so concurrent host work wins.
          await owned(() => git(['update-ref', `refs/heads/${branch}`, expected, snapshotCommit]));
          await owned(() => hostGit(worktreePath)(['reset', '--hard', expected]));
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
          ...(rewrittenFrom ? { rewrittenFrom } : {}),
        };
      } catch (err) {
        // If reset itself fails, return the branch only if it is still ours.
        await owned(() =>
          git(['update-ref', `refs/heads/${branch}`, expected, snapshotCommit]),
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

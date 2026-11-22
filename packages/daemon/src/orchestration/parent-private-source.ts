import { assertBoundedHeadPack } from '../managed/bounded-head-pack.js';
import { sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES, managedGit } from '../managed/source-git.js';
import { type CandidatePathAllowance, validateCandidatePathScope } from './candidate-path-scope.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';

export interface ParentPrivateSourceSelector {
  /** Exact host-selected parent commit. */
  base: string;
  /** Exact exported HEAD commit. */
  commit: string;
  /** Exact tree expected at the exported HEAD. */
  tree: string;
  /** Host-owned authorization. Never derive this from worker output. */
  allowlist: readonly CandidatePathAllowance[];
  /** Host-selected collection bound, additionally capped by MAX_CANDIDATE_BYTES. */
  maxBundleBytes: number;
}

export interface VerifiedParentPrivateSource {
  base: string;
  commit: string;
  tree: string;
  bundle: Buffer;
  bundleDigest: string;
  paths: readonly string[];
}

/**
 * Host-only verification for bytes exported by a trusted isolated collection boundary.
 * The bundle is hostile data: this imports objects into a disposable mirror and never
 * consumes a remote, credential, checkout path, worker-selected path, or dirty worktree.
 */
export async function verifyParentPrivateSource(
  scratch: string,
  exportedHeadBundle: Buffer,
  input: Readonly<ParentPrivateSourceSelector>,
): Promise<VerifiedParentPrivateSource> {
  if (
    !Buffer.isBuffer(exportedHeadBundle) ||
    !Number.isSafeInteger(input.maxBundleBytes) ||
    input.maxBundleBytes < 1 ||
    input.maxBundleBytes > MAX_CANDIDATE_BYTES ||
    exportedHeadBundle.length < 1 ||
    exportedHeadBundle.length > input.maxBundleBytes
  )
    throw new Error('parent-private-source-bundle-size');

  // Bind all mutable boundary values before the first await. The allowlist remains
  // host authority, but is copied so a caller cannot change that authority in flight.
  const bundle = Buffer.from(exportedHeadBundle);
  const bundleDigest = sha256(bundle);
  const base = input.base;
  const commit = input.commit;
  const tree = input.tree;
  const allowlist = Array.isArray(input.allowlist)
    ? input.allowlist.map((entry) => ({ kind: entry.kind, path: entry.path }))
    : input.allowlist;

  await assertBoundedHeadPack(bundle, commit);
  const scoped = await withVerifiedCheckpointMirror(
    scratch,
    { predecessor: base, commit, tree },
    bundle,
    async (mirror) => {
      // A single advertised ref is insufficient: a pack may carry hidden objects.
      if (await managedGit(mirror, ['fsck', '--full', '--unreachable', '--no-reflogs', commit]))
        throw new Error('parent-private-source-unreachable-objects');
      return validateCandidatePathScope({
        repository: mirror,
        base,
        candidate: commit,
        expectedTree: tree,
        allowlist,
      });
    },
  );

  return {
    base: scoped.base,
    commit: scoped.candidate,
    tree: scoped.tree,
    bundle: Buffer.from(bundle),
    bundleDigest,
    paths: [...scoped.changedPaths],
  };
}

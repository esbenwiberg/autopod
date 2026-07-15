import type { RunGit } from './bare-push.js';

export type TransferResult = { ok: true } | { ok: false; reason: string };

/**
 * Make a host-side commit resolvable inside a sandbox container that has an
 * **isolated git object store**.
 *
 * Sandbox containers do not share a filesystem (or object store) with the host
 * bare repo — their `/workspace/.git` is a snapshot taken at provisioning time.
 * A commit the daemon creates host-side afterwards (e.g. the auto-commit, or a
 * reconcile graft) therefore cannot be resolved in the container, so
 * `git reset --hard <thatCommit>` fails with "Could not parse object". This is
 * why the original host-side graft reconcile (see
 * `docs/sandbox-rework-reconcile-bug.md`) broke on sandbox.
 *
 * We bridge the two stores with a git bundle: package the missing commits
 * (`target`, incremental on `base` which the container already has), copy the
 * bundle into the container, and `git fetch` from it so the objects land in the
 * container's own store. After this returns `{ ok: true }`, `target` is a valid
 * object in the container and the caller can reset the workspace to it.
 *
 * `base` MUST be an ancestor the container already has (normally the container's
 * own HEAD) so the incremental bundle's prerequisites are satisfied.
 *
 * Returns `{ ok: false, reason }` instead of throwing so the caller can fall back
 * to quarantining on any failure.
 */
export async function transferCommitToContainer(deps: {
  hostGit: RunGit;
  containerGit: RunGit;
  /** Create the bundle on the host, then land it at `containerBundlePath` in the container. */
  transferBundle: (hostBundlePath: string, containerBundlePath: string) => Promise<void>;
  hostBundlePath: string;
  containerBundlePath: string;
  /** Namespace no worktree has checked out, used to name the transfer on both ends. */
  transferRef: string;
  target: string;
  base: string;
}): Promise<TransferResult> {
  const {
    hostGit,
    containerGit,
    transferBundle,
    hostBundlePath,
    containerBundlePath,
    transferRef,
    target,
    base,
  } = deps;

  const cleanupHostRef = async () => {
    await hostGit(['update-ref', '-d', transferRef]);
  };
  const cleanupContainerRef = async () => {
    await containerGit(['update-ref', '-d', transferRef]);
  };

  // A bare SHA is not bundleable — name it with a throwaway ref so the bundle and
  // the container-side fetch have a ref to move.
  const setRef = await hostGit(['update-ref', transferRef, target]);
  if (setRef.exitCode !== 0) {
    return { ok: false, reason: `host update-ref: ${setRef.stderr.trim() || 'failed'}` };
  }

  const bundle = await hostGit(['bundle', 'create', hostBundlePath, transferRef, '--not', base]);
  if (bundle.exitCode !== 0) {
    await cleanupHostRef();
    return { ok: false, reason: `host bundle: ${bundle.stderr.trim() || 'failed'}` };
  }

  try {
    await transferBundle(hostBundlePath, containerBundlePath);
  } catch (err) {
    await cleanupHostRef();
    return { ok: false, reason: `transfer: ${(err as Error).message}` };
  }

  try {
    const fetch = await containerGit([
      'fetch',
      containerBundlePath,
      `${transferRef}:${transferRef}`,
    ]);
    if (fetch.exitCode !== 0) {
      return { ok: false, reason: `container fetch: ${fetch.stderr.trim() || 'failed'}` };
    }
    // Sanity: the object is now resolvable in the container's own store.
    const check = await containerGit(['cat-file', '-e', `${target}^{commit}`]);
    if (check.exitCode !== 0) {
      return { ok: false, reason: 'container still cannot resolve target after fetch' };
    }
    return { ok: true };
  } finally {
    await cleanupContainerRef();
    await cleanupHostRef();
  }
}

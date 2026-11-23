import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { anchoredHeadHeader, assertBoundedAnchoredHeadPack } from '../managed/bounded-head-pack.js';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import { managedGit, managedGitBytes } from '../managed/source-git.js';

const oid = /^[a-f0-9]{40}$/;
export const MAX_ANCHORED_INTEGRATION_BYTES = 2 * MAX_PRIVATE_HEAD_BYTES;

export interface AnchoredSelection {
  commit: string;
  tree: string;
  predecessor: string;
  predecessorTree: string;
}

export interface ParentDeltaSource {
  withBase<T>(use: (mirror: string) => Promise<T>): Promise<T>;
  base: string;
  tree: string;
}
type DeltaHead = Readonly<Pick<AnchoredSelection, 'commit' | 'tree' | 'predecessor'>>;

/** Trusted host or evaluator resolver, independent of the transported bytes. */
export function restoreParentDelta<T>(
  source: ParentDeltaSource,
  scratch: string,
  subject: DeltaHead,
  bundle: Buffer,
  use: (mirror: string) => Promise<T>,
) {
  if (source.base !== subject.predecessor) throw new Error('anchored-delegation-base-mismatch');
  return source.withBase((baseMirror) =>
    withVerifiedAnchoredDelegationMirror(
      {
        scratch,
        baseMirror,
        selection: { ...subject, predecessorTree: source.tree },
        bundle,
      },
      use,
    ),
  );
}

export function restoreParentSource<T>(
  legacy: <R>(
    scratch: string,
    subject: DeltaHead,
    bundle: Buffer,
    use: (mirror: string) => Promise<R>,
  ) => Promise<R>,
  delta: ParentDeltaSource | undefined,
  scratch: string,
  subject: DeltaHead,
  bundle: Buffer,
  use: (mirror: string) => Promise<T>,
) {
  return delta
    ? restoreParentDelta(delta, scratch, subject, bundle, use)
    : legacy(scratch, subject, bundle, use);
}

function assertSelection(selection: Readonly<AnchoredSelection>, maxBytes: number) {
  const { commit, tree, predecessor, predecessorTree } = selection;
  if (
    ![commit, tree, predecessor, predecessorTree].every((id) => oid.test(id)) ||
    commit === predecessor ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256 ||
    maxBytes > MAX_ANCHORED_INTEGRATION_BYTES
  )
    throw new Error('anchored-delegation-source-binding');
}

async function requireCommitTree(mirror: string, commit: string, tree: string) {
  if (
    (await managedGit(mirror, ['rev-parse', '--verify', `${commit}^{commit}`])) !== commit ||
    (await managedGit(mirror, ['rev-parse', '--verify', `${commit}^{tree}`])) !== tree
  )
    throw new Error('anchored-delegation-tree-mismatch');
}

/** Make a standard Git bundle carrying only objects after the pinned base. The
 * caller owns the mirror; worker bytes cannot supply repository locations or refs. */
export async function exportAnchoredDelegationBundle(
  mirror: string,
  selection: Readonly<AnchoredSelection>,
  maxBytes = MAX_ANCHORED_INTEGRATION_BYTES,
) {
  assertSelection(selection, maxBytes);
  const { commit, tree, predecessor, predecessorTree } = selection;
  await requireCommitTree(mirror, predecessor, predecessorTree);
  await requireCommitTree(mirror, commit, tree);
  await managedGit(mirror, ['merge-base', '--is-ancestor', predecessor, commit]);
  const header = anchoredHeadHeader(predecessor, commit);
  const pack = await managedGitBytes(
    mirror,
    [
      '-c',
      'pack.threads=1',
      'pack-objects',
      '--revs',
      '--stdout',
      '--window=0',
      '--no-reuse-object',
      '--no-reuse-delta',
      '--no-use-bitmap-index',
    ],
    undefined,
    [],
    { input: `${commit}\n^${predecessor}\n`, maxBuffer: maxBytes - header.length, timeout: 12_000 },
  );
  const result = Buffer.concat([header, pack]);
  await assertBoundedAnchoredHeadPack(result, predecessor, commit);
  return result;
}

/** Import into an isolated scratch mirror. The independently supplied bare
 * mirror is trusted/read-only and must already contain the exact accepted base.
 * Read its objects only; do not inherit its refs, repository config, or remotes. */
export async function withVerifiedAnchoredDelegationMirror<T>(
  input: {
    scratch: string;
    baseMirror: string;
    selection: Readonly<AnchoredSelection>;
    bundle: Buffer;
    maxBytes?: number;
  },
  use: (mirror: string) => Promise<T>,
): Promise<T> {
  const maxBytes = input.maxBytes ?? MAX_ANCHORED_INTEGRATION_BYTES;
  const selection = { ...input.selection };
  assertSelection(selection, maxBytes);
  if (!Buffer.isBuffer(input.bundle) || !input.bundle.length || input.bundle.length > maxBytes)
    throw new Error('anchored-delegation-bundle-size');
  const bundle = Buffer.from(input.bundle);
  const { commit, tree, predecessor, predecessorTree } = selection;
  await assertBoundedAnchoredHeadPack(bundle, predecessor, commit);
  return withAnchoredBaseWorkspace(
    input.scratch,
    input.baseMirror,
    predecessor,
    predecessorTree,
    async (mirror) => {
      const file = path.join(path.dirname(mirror), 'delta.bundle');
      await writeFile(file, bundle, { flag: 'wx', mode: 0o600 });
      const heads = await managedGit(mirror, ['bundle', 'unbundle', file]);
      if (heads !== `${commit} HEAD`) throw new Error('anchored-delegation-head-mismatch');
      await requireCommitTree(mirror, commit, tree);
      await managedGit(mirror, ['merge-base', '--is-ancestor', predecessor, commit]);
      await managedGit(mirror, ['fsck', '--strict', '--no-reflogs', '--no-full', commit]);
      await managedGit(mirror, ['update-ref', 'refs/heads/main', commit, predecessor]);
      return use(mirror);
    },
  );
}

/** All writes are to the disposable mirror, never the retained base. */
export async function withAnchoredBaseWorkspace<T>(
  scratch: string,
  baseMirror: string,
  predecessor: string,
  predecessorTree: string,
  use: (mirror: string) => Promise<T>,
): Promise<T> {
  if (!path.isAbsolute(baseMirror) || !oid.test(predecessor) || !oid.test(predecessorTree))
    throw new Error('anchored-delegation-base-mirror');
  const root = await realpath(baseMirror);
  const objects = path.join(root, 'objects');
  if (
    /[\r\n\0]/.test(objects) ||
    (await realpath(objects)) !== objects ||
    !(await stat(objects)).isDirectory()
  )
    throw new Error('anchored-delegation-base-mirror');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(scratch, 'anchor-'));
  try {
    const mirror = path.join(temp, 'mirror.git');
    await managedGit(temp, ['init', '--bare', '-b', 'main', '--object-format=sha1', mirror]);
    await writeFile(path.join(mirror, 'objects', 'info', 'alternates'), `${objects}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await requireCommitTree(mirror, predecessor, predecessorTree);
    await managedGit(mirror, ['update-ref', 'refs/heads/main', predecessor]);
    return await use(mirror);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SavedWorkSource } from '@autopod/shared';
import { draftError } from '../pods/saved-work-draft-repository.js';
import type { CheckpointRecord } from '../pods/workspace-checkpoint-controller.js';
import { assertCheckpointRepository } from './retained-checkpoint-workspace.js';
import { inspectPreservationGit, safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function savedGit(cwd: string, assertCurrent = () => {}) {
  return safeAdoptionGit(async (args) => {
    assertCurrent();
    const result = await exec('git', args, {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assertCurrent();
    return result;
  });
}
async function savedRoot(worktree: string) {
  if ((await lstat(worktree)).isSymbolicLink()) draftError('Original source root is a symlink.');
  return realpath(worktree);
}
async function verifySourceIdentity(worktree: string, repository: string, source: SavedWorkSource) {
  assertCheckpointRepository(repository);
  const git = savedGit(worktree);
  const remote = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
  if (remote.replace(/\.git$/, '') !== repository.replace(/\.git$/, ''))
    draftError('Saved source repository differs from frozen repository.');
  if (
    !oid.test(source.commit) ||
    !oid.test(source.tree) ||
    (source.parent && !oid.test(source.parent)) ||
    (source.parentTree && !oid.test(source.parentTree))
  )
    draftError('Invalid saved object identity.');
  await git(['check-ref-format', source.ref]);
  if (
    (await git(['rev-parse', '--verify', `${source.ref}^{commit}`])).stdout.trim() !== source.commit
  )
    draftError('Saved reference no longer matches recorded proof.');
  if ((await git(['rev-parse', `${source.commit}^{tree}`])).stdout.trim() !== source.tree)
    draftError('Saved tree differs from recorded proof.');
  // An original sandbox HEAD has no synthetic parent receipt. Require the
  // daemon's verified committed quarantine ref, not just any ref to that OID.
  const committedSequence = /^refs\/autopod-quarantine\/[\w-]+\/(\d+)-committed$/.exec(
    source.ref,
  )?.[1];
  const committedCheckpoint =
    source.kind === 'sandbox-checkpoint' &&
    source.parent === null &&
    source.parentTree === null &&
    committedSequence !== undefined &&
    source.id === `checkpoint-${committedSequence}`;
  // Read the actual commit header; revision traversal can honor legacy grafts.
  const raw = (await git(['cat-file', 'commit', source.commit])).stdout;
  const separator = raw.indexOf('\n\n');
  const headers = raw.slice(0, separator);
  const lines = headers.split('\n');
  const parents = lines.filter((line) => line.startsWith('parent '));
  if (
    source.kind === 'sandbox-checkpoint' &&
    !committedCheckpoint &&
    (separator < 0 ||
      !source.parent ||
      !source.parentTree ||
      raw.slice(separator + 2).split('\n')[0] !== 'autopod sandbox checkpoint' ||
      lines.filter((line) => /^author Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line))
        .length !== 1 ||
      lines.filter((line) =>
        /^committer Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line),
      ).length !== 1)
  )
    draftError('Saved checkpoint lacks the daemon-authored raw snapshot identity.');
  if (!headers.split('\n').includes(`tree ${source.tree}`))
    draftError('Actual commit object has a different saved tree.');
  if (source.parent && (parents.length !== 1 || parents[0] !== `parent ${source.parent}`))
    draftError('Saved snapshot parent differs from recorded lineage.');
  if (
    source.parent &&
    source.parentTree &&
    (await git(['rev-parse', `${source.parent}^{tree}`])).stdout.trim() !== source.parentTree
  )
    draftError('Saved parent tree differs from recorded proof.');
  if (/^160000 /m.test((await git(['ls-tree', '-r', source.commit])).stdout))
    draftError('Saved submodules require explicit recursive source custody.');
  const config = (await git(['config', '--null', '--list'])).stdout;
  if (/(?:^|\0)(?:filter\.|extensions\.partialclone|remote\..*\.promisor)/i.test(config))
    draftError('Filters or partial source require explicit materialization policy.');
}

async function verifyGraphs(worktree: string, roots: string[]) {
  const git = savedGit(worktree);
  // --quiet suppresses the object list, not the traversal or its exit status.
  await git(['rev-list', '--objects', '--missing=error', '--quiet', ...roots]);
  await git(['fsck', '--strict', '--no-reflogs', '--no-dangling', ...roots]);
}

export async function verifySavedSource(
  worktree: string,
  repository: string,
  source: SavedWorkSource,
) {
  const root = await savedRoot(worktree);
  await verifySourceIdentity(root, repository, source);
  await verifyGraphs(root, [source.commit]);
}

function checkpointCandidate(
  podId: string,
  record: CheckpointRecord,
  latestSequence: number,
): SavedWorkSource {
  const r = record.result;
  const token = podId.replace(/[^A-Za-z0-9_-]/g, '_');
  const committed = r.snapshotCommit === r.sourceHead;
  const expectedRef = `refs/autopod-quarantine/${token}/${record.sequence}${committed ? '-committed' : ''}`;
  if (
    record.podId !== podId ||
    record.sequence !== r.sequence ||
    !r.transferVerified ||
    !r.bundleVerified ||
    !r.hostImported ||
    !r.lineageVerified ||
    r.quarantineRef !== expectedRef ||
    (committed && r.sourceTree !== r.snapshotTree) ||
    (r.error && !(r.error.phase === 'promotion' && r.error.code === 'LINEAGE_CONFLICT'))
  )
    draftError('Checkpoint lacks complete imported lineage proof or failed beyond promotion.');
  const source: SavedWorkSource = {
    id: `checkpoint-${record.sequence}`,
    kind: 'sandbox-checkpoint',
    commit: r.snapshotCommit,
    tree: r.snapshotTree,
    parent: committed ? null : r.sourceHead,
    parentTree: committed ? null : r.sourceTree,
    ref: r.quarantineRef,
    capturedAt: record.capturedAt ?? record.verifiedAt,
    freshness: record.sequence === latestSequence ? 'latest-saved' : 'older-saved',
    exclusions:
      'Only the recorded saved snapshot is included. Later sandbox edits and unsaved host/index work are excluded; the live sandbox was not read.',
  };
  return source;
}

export async function checkpointSavedSource(
  podId: string,
  worktree: string,
  repository: string,
  record: CheckpointRecord,
  latestSequence: number,
) {
  const source = checkpointCandidate(podId, record, latestSequence);
  await verifySavedSource(worktree, repository, source);
  return source;
}

async function localCandidate(worktree: string, branch: string): Promise<SavedWorkSource> {
  const identity = await inspectPreservationGit(savedGit(worktree), branch);
  const source: SavedWorkSource = {
    id: `local-${identity.head}`,
    kind: 'local-commit',
    commit: identity.head,
    tree: identity.tree,
    parent: null,
    parentTree: null,
    ref: `refs/heads/${branch}`,
    capturedAt: null,
    freshness: 'host-commit-only',
    exclusions:
      'Committed host HEAD only. Dirty files, index changes, ignored files and any uncaptured sandbox work are excluded; capture freshness is unknown.',
  };
  return source;
}

export async function localSavedSource(worktree: string, repository: string, branch: string) {
  const source = await localCandidate(worktree, branch);
  await verifySavedSource(worktree, repository, source);
  return source;
}

/** Only share graph traversal within one inspection of one object store. Every ref
 * and receipt still needs its own identity proof, even when multiple refs name one OID. */
export async function inspectSavedWorkSources(
  podId: string,
  worktree: string,
  repository: string,
  branch: string,
  records: CheckpointRecord[],
) {
  const root = await savedRoot(worktree);
  const candidates: SavedWorkSource[] = [];
  const blockers: string[] = [];
  const latest = records[0]?.sequence ?? 0;
  async function check(label: string, candidate: () => SavedWorkSource | Promise<SavedWorkSource>) {
    try {
      const source = await candidate();
      await verifySourceIdentity(root, repository, source);
      candidates.push(source);
    } catch (error) {
      blockers.push(
        `${label} unavailable: ${error instanceof Error ? error.message : 'unverified source'}`,
      );
    }
  }
  for (const record of records) {
    await check(`Snapshot ${record.sequence}`, () => checkpointCandidate(podId, record, latest));
  }
  await check('Host commit', () => localCandidate(root, branch));
  const roots = [...new Set(candidates.map((s) => s.commit))];
  if (roots.length) {
    try {
      await verifyGraphs(root, roots);
    } catch (error) {
      // Do not present any candidate as verified from a partial or failed batch.
      blockers.push(
        `Saved object verification failed: ${error instanceof Error ? error.message : 'unverified graph'}`,
      );
      return { sources: [], blockers };
    }
  }
  return { sources: candidates, blockers };
}

/** New independent object store and checkout; no original refs, index or files change. */
export async function prepareSavedSource(args: {
  worktree: string;
  root: string;
  repository: string;
  source: SavedWorkSource;
  branch: string;
  assertCurrent(): void;
}): Promise<string> {
  await verifySavedSource(args.worktree, args.repository, args.source);
  const parent = await realpath(path.dirname(args.root));
  const root = path.join(parent, path.basename(args.root));
  const original = await realpath(args.worktree);
  const disjoint = (a: string, b: string) => {
    const rel = path.relative(a, b);
    return rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel);
  };
  if (!disjoint(original, root) || !disjoint(root, original))
    draftError('Independent source namespace overlaps original.');
  args.assertCurrent();
  await mkdir(root, { mode: 0o700 }); // Exclusive: an interrupted preparation is never replayed.
  if ((await realpath(root)) !== root) draftError('Independent source namespace changed.');
  const bundle = path.join(root, 'saved.bundle');
  await savedGit(original, args.assertCurrent)(['bundle', 'create', bundle, args.source.ref]);
  await savedGit(original, args.assertCurrent)(['bundle', 'verify', bundle]);
  const checkout = path.join(root, 'worktree');
  await savedGit(
    root,
    args.assertCurrent,
  )(['clone', '--no-checkout', '--no-local', '--', bundle, checkout]);
  const git = savedGit(checkout, args.assertCurrent);
  // Clone's default refspec omits quarantine refs. Import only the selected ref
  // into the NEW object store; no source ref or unrelated branch is rewritten.
  await git([
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--',
    bundle,
    `${args.source.ref}:refs/autopod/saved-source`,
  ]);
  if ((await git(['rev-parse', 'refs/autopod/saved-source'])).stdout.trim() !== args.source.commit)
    draftError('Independent import differs from the selected saved source.');
  await git(['remote', 'set-url', 'origin', args.repository]);
  await git(['checkout', '-b', args.branch, args.source.commit]);
  const identity = await inspectPreservationGit(git, args.branch);
  if (
    identity.head !== args.source.commit ||
    identity.tree !== args.source.tree ||
    !identity.worktreeClean
  )
    draftError('Independent checkout does not contain the exact selected source.');
  await verifySavedSource(args.worktree, args.repository, args.source);
  args.assertCurrent();
  return checkout;
}

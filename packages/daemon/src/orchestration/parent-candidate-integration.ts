import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES, managedGit, managedGitBytes } from '../managed/source-git.js';
import {
  exportAnchoredDelegationBundle,
  type ParentDeltaSource,
  restoreParentSource,
} from './anchored-delegation-source.js';
import {
  assertPortableCandidateTree,
  type CandidatePathAllowance,
  validateCandidatePathScope,
} from './candidate-path-scope.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { type ParentCandidateSelection, readParentCandidate } from './parent-candidate-custody.js';

export interface ParentIntegrationInput extends ParentCandidateSelection {
  expectedTree: string;
  allowlist: readonly CandidatePathAllowance[];
}

async function changes(mirror: string, base: string, tip: string) {
  const raw = await managedGitBytes(mirror, [
    'diff-tree',
    '--no-commit-id',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '-r',
    '-z',
    base,
    tip,
    '--',
  ]);
  const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0');
  if (fields.pop() !== '' || fields.length % 2 || fields.length > 4096)
    throw new Error('parent-integration-invalid-diff');
  const rows = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) {
    const metadata = fields[i];
    const name = fields[i + 1];
    if (
      !name ||
      !metadata ||
      !/^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} [AMD]$/.test(metadata) ||
      rows.has(name)
    )
      throw new Error('parent-integration-invalid-diff');
    rows.set(name, metadata);
  }
  return rows;
}

function readIntegrationPair(
  db: Database.Database,
  run: string,
  inputs: readonly Readonly<ParentCandidateSelection>[],
) {
  const [left, right] = inputs;
  if (inputs.length !== 2 || !left || !right || left.requestKey === right.requestKey)
    throw new Error('parent-integration-distinct-inputs-required');
  return db.transaction(() => {
    const context = db
      .prepare(`SELECT r.accepted_commit, r.accepted_evidence, r.policy_digest,
      p.policy_digest AS parent_policy, p.pod_id FROM orchestration_runs r
      JOIN parent_managed_runs p ON p.run_id=r.id WHERE r.id=? AND r.canceled=0`)
      .get(run);
    if (!context) throw new Error('parent-candidate-unavailable');
    return {
      fingerprint: digest(context),
      a: readParentCandidate(db, run, left),
      b: readParentCandidate(db, run, right),
    };
  })();
}

/** Rebind an already qualified integration without rebuilding or rerunning checks. */
export function assertParentIntegrationBinding(
  db: Database.Database,
  run: string,
  inputs: readonly Readonly<Omit<ParentIntegrationInput, 'allowlist'> & { scopeDigest: string }>[],
  expected: string,
) {
  const { fingerprint, a, b } = readIntegrationPair(db, run, inputs);
  if (
    [a, b].some(
      (value, index) =>
        value.scopeDigest !== inputs[index]?.scopeDigest ||
        value.tree !== inputs[index]?.expectedTree,
    ) ||
    digest([fingerprint, a.authorityDigest, b.authorityDigest]) !== expected
  )
    throw new Error('parent-integration-stale');
}

/** Private offline preview only, never admission or delivery authority. */
export async function buildParentIntegration(
  db: Database.Database,
  scratch: string,
  run: string,
  inputs: readonly [Readonly<ParentIntegrationInput>, Readonly<ParentIntegrationInput>],
  delta?: ParentDeltaSource,
) {
  const frozen = structuredClone(inputs);
  const [left, right] = frozen;
  const readPair = () => readIntegrationPair(db, run, frozen);
  const { a, b, fingerprint } = readPair();
  if (
    a.scopeDigest !== digest(left.allowlist) ||
    a.tree !== left.expectedTree ||
    b.scopeDigest !== digest(right.allowlist) ||
    b.tree !== right.expectedTree
  )
    throw new Error('parent-candidate-scope-mismatch');
  if (a.base !== b.base || a.receipt.newCommit === b.receipt.newCommit)
    throw new Error('parent-integration-base-or-candidate-mismatch');
  const base = a.base;
  const subject = (material: typeof a, selected: ParentIntegrationInput) => ({
    predecessor: base,
    commit: material.receipt.newCommit,
    tree: selected.expectedTree,
  });
  const validate = (repository: string, selected: ParentIntegrationInput, material: typeof a) =>
    validateCandidatePathScope({
      repository,
      base,
      candidate: material.receipt.newCommit,
      expectedTree: selected.expectedTree,
      allowlist: selected.allowlist,
      allowInheritedPublishedEntries: Boolean(delta),
    });
  const rightScope = await restoreParentSource(
    withVerifiedCheckpointMirror,
    delta,
    scratch,
    subject(b, right),
    b.bundle,
    (mirror) => validate(mirror, right, b),
  );
  const snapshot = await restoreParentSource(
    withVerifiedCheckpointMirror,
    delta,
    scratch,
    subject(a, left),
    a.bundle,
    async (mirror) => {
      const leftScope = await validate(mirror, left, a);
      const expected = await changes(mirror, base, a.receipt.newCommit);
      const lower = leftScope.changedPaths.map((name) => name.toLowerCase());
      if (
        rightScope.changedPaths.some((name) => {
          const key = name.toLowerCase();
          return lower.some(
            (other) => key === other || key.startsWith(other + '/') || other.startsWith(key + '/'),
          );
        })
      )
        throw new Error('parent-integration-overlap');

      // Import only verified retained objects; never copy refs, config, or remote bindings.
      const rightFile = path.join(mirror, 'right.bundle');
      await writeFile(rightFile, b.bundle, { flag: 'wx', mode: 0o600 });
      const rightHead = await managedGit(mirror, ['bundle', 'unbundle', rightFile]);
      if (!rightHead.split('\n').includes(`${b.receipt.newCommit} HEAD`))
        throw new Error('parent-integration-right-binding');
      for (const [name, metadata] of await changes(mirror, base, b.receipt.newCommit)) {
        if (expected.has(name)) throw new Error('parent-integration-overlap');
        expected.set(name, metadata);
      }

      const parents = [a.receipt.newCommit, b.receipt.newCommit];
      const tree = await managedGit(mirror, ['merge-tree', '--write-tree', ...parents]);
      if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('parent-integration-tree-invalid');
      await assertPortableCandidateTree(mirror, tree, delta?.base);
      const actual = await changes(mirror, base, tree);
      if (
        actual.size !== expected.size ||
        [...expected].some(([name, value]) => actual.get(name) !== value)
      )
        throw new Error('parent-integration-not-exact-union');

      // Deterministic Git metadata, derived from the two verified immutable commits.
      const times = await managedGit(mirror, ['show', '-s', '--format=%ct', ...parents]);
      if (!/^\d{1,12}\n\d{1,12}$/.test(times))
        throw new Error('parent-integration-timestamp-invalid');
      const timestamp = Math.max(...times.split('\n').map(Number));
      const identity = `Autopod Integration <integration@autopod.invalid> ${timestamp} +0000`;
      const commitFile = path.join(mirror, 'combined.commit');
      await writeFile(
        commitFile,
        [
          `tree ${tree}`,
          ...parents.map((id) => `parent ${id}`),
          `author ${identity}`,
          `committer ${identity}`,
          '',
          'Private parent integration',
          '',
        ].join('\n'),
        { flag: 'wx', mode: 0o600 },
      );
      const commit = await managedGit(mirror, [
        'hash-object',
        '-t',
        'commit',
        '-w',
        '--',
        commitFile,
      ]);
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('parent-integration-commit-invalid');
      await managedGit(mirror, [
        'fsck',
        '--strict',
        '--no-reflogs',
        ...(delta ? ['--no-full'] : []),
        commit,
      ]);
      await managedGit(mirror, ['update-ref', '--no-deref', 'HEAD', commit]);
      const bundle = delta
        ? await exportAnchoredDelegationBundle(mirror, {
            predecessor: base,
            predecessorTree: delta.tree,
            commit,
            tree,
          })
        : await (async () => {
            const bundleFile = path.join(mirror, 'integration.bundle');
            await managedGit(mirror, ['bundle', 'create', bundleFile, 'HEAD']);
            const size = (await stat(bundleFile)).size;
            if (size <= 0 || size > MAX_CANDIDATE_BYTES)
              throw new Error('parent-integration-bundle-size');
            const bundle = await readFile(bundleFile);
            if (bundle.length !== size) throw new Error('parent-integration-bundle-size');
            return bundle;
          })();
      return {
        base,
        commit,
        tree,
        bundle,
        bundleDigest: sha256(bundle),
        paths: [...actual.keys()].sort(),
        inputs: [left, right].map(({ allowlist, ...selection }) => ({
          ...selection,
          scopeDigest: digest(allowlist),
        })),
      };
    },
  );
  const isSame = (before: typeof a, after: typeof a) =>
    before.base === after.base &&
    before.authorityDigest === after.authorityDigest &&
    canonical(before.receipt) === canonical(after.receipt) &&
    before.bundle.equals(after.bundle);
  const assertCurrent = () => {
    let final: ReturnType<typeof readPair>;
    try {
      final = readPair();
    } catch (cause) {
      throw new Error('parent-integration-stale', { cause });
    }
    if (final.fingerprint !== fingerprint || !isSame(a, final.a) || !isSame(b, final.b))
      throw new Error('parent-integration-stale');
  };
  assertCurrent();
  return {
    ...snapshot,
    bindingDigest: digest([fingerprint, a.authorityDigest, b.authorityDigest]),
    assertCurrent,
  };
}

import { managedGitBytes } from '../managed/source-git.js';

const OBJECT_ID = /^[0-9a-f]{40}$/;
const REGULAR_MODES = new Set(['100644', '100755']);

export type CandidatePathAllowance = Readonly<{
  kind: 'file' | 'directory';
  path: string;
}>;

export interface CandidatePathScopeRequest {
  /** Trusted local repository containing the already-imported private objects. */
  repository: string;
  /** Exact host-selected parent commit. */
  base: string;
  /** Exact privately imported one-commit candidate. */
  candidate: string;
  /** Exact tree the host expects the candidate commit to contain. */
  expectedTree: string;
  /** Host authorization. Candidate-controlled text must never populate this list. */
  allowlist: readonly CandidatePathAllowance[];
}

export interface CandidatePathScopeResult {
  base: string;
  candidate: string;
  tree: string;
  changedPaths: readonly string[];
}

function fail(reason: string): never {
  throw new Error(`candidate-path-scope-${reason}`);
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('invalid-output');
  }
}

function validateObjectId(value: string, label: string): void {
  if (!OBJECT_ID.test(value)) fail(label);
}

// The first coding lane deliberately accepts only portable ASCII names.
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
function validatePath(value: string): string {
  if (value.length > 4096) fail('path-invalid');
  if (
    value
      .split('/')
      .some(
        (component) =>
          !/^[A-Za-z0-9_.-]{1,255}$/.test(component) ||
          component.endsWith('.') ||
          component.toLowerCase() === '.git' ||
          reservedName.test(component),
      )
  )
    fail('path-invalid');
  return value;
}

function portablePathKey(value: string): string {
  return value.toLowerCase();
}

function validateAllowlist(entries: readonly CandidatePathAllowance[]): CandidatePathAllowance[] {
  if (!Array.isArray(entries) || entries.length === 0) fail('allowlist-required');
  if (entries.length > 128) fail('allowlist-too-large');
  const result: CandidatePathAllowance[] = [];
  const identities = new Set<string>();
  for (const entry of entries) {
    if (
      !entry ||
      (entry.kind !== 'file' && entry.kind !== 'directory') ||
      typeof entry.path !== 'string'
    )
      fail('allowlist-invalid');
    const authorizedPath = validatePath(entry.path);
    const identity = portablePathKey(authorizedPath);
    if (identities.has(identity)) fail('path-collision');
    identities.add(identity);
    result.push({ kind: entry.kind, path: authorizedPath });
  }
  return result;
}

function isAuthorized(path: string, allowlist: readonly CandidatePathAllowance[]): boolean {
  return allowlist.some((entry) =>
    entry.kind === 'file' ? path === entry.path : path.startsWith(`${entry.path}/`),
  );
}

function parseCommit(raw: Buffer): { tree: string; parents: string[] } {
  const text = decode(raw);
  const headerEnd = text.indexOf('\n\n');
  if (headerEnd < 0) fail('commit-invalid');
  let tree: string | undefined;
  const parents: string[] = [];
  for (const line of text.slice(0, headerEnd).split('\n')) {
    if (line.startsWith('tree ')) {
      if (tree) fail('commit-invalid');
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    } else if (/^[a-z]+ /.test(line) && !/^(author|committer|encoding|gpgsig) /.test(line)) {
      fail('commit-invalid');
    }
  }
  if (!tree || !OBJECT_ID.test(tree) || parents.some((parent) => !OBJECT_ID.test(parent)))
    fail('commit-invalid');
  return { tree, parents };
}

interface RawChange {
  oldMode: string;
  newMode: string;
  status: string;
  path: string;
}

function parseRawChanges(raw: Buffer): RawChange[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0) {
      fields.push(raw.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== raw.length || fields.length % 2 !== 0) fail('diff-invalid');
  if (fields.length > 2048) fail('too-many-changes');

  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadataField = fields[index];
    const pathField = fields[index + 1];
    if (!metadataField || !pathField) fail('diff-invalid');
    const metadata = decode(metadataField);
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])$/.exec(metadata);
    const oldMode = match?.[1];
    const newMode = match?.[2];
    const status = match?.[5];
    if (!oldMode || !newMode || !status) fail('diff-invalid');
    changes.push({
      oldMode,
      newMode,
      status,
      path: validatePath(decode(pathField)),
    });
  }
  return changes;
}

// A new name can collide with an unchanged tracked path, not just another diff
// entry. Include directories so aliases cannot hide under different leaf names.
export async function assertPortableCandidateTree(repository: string, commit: string) {
  validateObjectId(commit, 'tree-invalid');
  const text = decode(
    await managedGitBytes(repository, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit]),
  );
  if (!text) return; // All files may have been deleted within the grant.
  if (!text.endsWith('\0')) fail('tree-invalid');
  const names = new Set<string>();
  const entries = text.slice(0, -1).split('\0');
  if (entries.length > 20_000) fail('tree-too-large');
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || !/^(?:040000 tree|100(?:644|755) blob) [0-9a-f]{40}$/.test(entry.slice(0, tab)))
      fail('tree-invalid');
    const key = portablePathKey(validatePath(entry.slice(tab + 1)));
    if (names.has(key)) fail('path-collision');
    names.add(key);
  }
}

function validateChange(change: RawChange): void {
  const { oldMode, newMode, status } = change;
  if (status === 'A') {
    if (oldMode !== '000000' || !REGULAR_MODES.has(newMode)) fail('mode-invalid');
    return;
  }
  if (status === 'D') {
    if (!REGULAR_MODES.has(oldMode) || newMode !== '000000') fail('mode-invalid');
    return;
  }
  if (
    status !== 'M' ||
    !REGULAR_MODES.has(oldMode) ||
    !REGULAR_MODES.has(newMode) ||
    oldMode !== newMode
  )
    fail('mode-invalid');
}

/**
 * Read-only, offline authorization check for one already-imported candidate commit.
 * It does not fetch, update refs, check out files, or derive authority from candidate data.
 */
export async function validateCandidatePathScope(
  request: Readonly<CandidatePathScopeRequest>,
): Promise<CandidatePathScopeResult> {
  validateObjectId(request.base, 'base-invalid');
  validateObjectId(request.candidate, 'candidate-invalid');
  validateObjectId(request.expectedTree, 'tree-invalid');
  if (request.base === request.candidate) fail('candidate-invalid');
  const allowlist = validateAllowlist(request.allowlist);

  const base = decode(
    await managedGitBytes(request.repository, [
      'rev-parse',
      '--verify',
      `${request.base}^{commit}`,
    ]),
  ).trim();
  if (base !== request.base) fail('base-mismatch');

  const candidate = decode(
    await managedGitBytes(request.repository, [
      'rev-parse',
      '--verify',
      `${request.candidate}^{commit}`,
    ]),
  ).trim();
  if (candidate !== request.candidate) fail('candidate-mismatch');

  const commit = parseCommit(
    await managedGitBytes(request.repository, ['cat-file', 'commit', request.candidate]),
  );
  if (commit.parents.length !== 1 || commit.parents[0] !== request.base) fail('base-mismatch');
  if (commit.tree !== request.expectedTree) fail('tree-mismatch');

  const changes = parseRawChanges(
    await managedGitBytes(request.repository, [
      'diff-tree',
      '--no-commit-id',
      '--raw',
      '-r',
      '-z',
      '--no-renames',
      '--no-abbrev',
      request.base,
      request.candidate,
      '--',
    ]),
  );
  if (changes.length === 0) fail('changes-required');

  const identities = new Map<string, string>();
  for (const change of changes) {
    validateChange(change);
    const identity = portablePathKey(change.path);
    for (const [priorIdentity, priorPath] of identities) {
      if (
        priorPath !== change.path &&
        (priorIdentity === identity ||
          priorIdentity.startsWith(`${identity}/`) ||
          identity.startsWith(`${priorIdentity}/`))
      )
        fail('path-collision');
    }
    identities.set(identity, change.path);
    if (!isAuthorized(change.path, allowlist)) fail('path-not-allowed');
  }

  const changedPaths = [...new Set(changes.map((change) => change.path))].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  );
  await assertPortableCandidateTree(request.repository, request.candidate);
  return { base: request.base, candidate: request.candidate, tree: commit.tree, changedPaths };
}

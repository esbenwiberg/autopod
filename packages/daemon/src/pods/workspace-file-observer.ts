import type { AgentFileChangeEvent } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 30_000;
export const FILE_OBSERVATION_INTERVAL_MS = 15_000;

/**
 * Read-only, bounded manifest of HEAD plus working-tree overrides. Git object IDs
 * plus stable file identities let a commit of unchanged bytes compare equal,
 * even when Git normalizes line endings. Hash raw bytes: never run clean filters,
 * write Git objects, update the index, follow file symlinks, or return contents.
 * Node is part of every supported agent image (the agent CLIs require it).
 */
export const WORKSPACE_FILE_SNAPSHOT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = fs.realpathSync('.');
const gitOptions = {
  encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
};
// Even a read-only diff may run configured clean/fsmonitor programs. Disable
// every configured filter for this observation; never execute repository tools.
let filterKeys = '';
try {
  filterKeys = execFileSync('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], gitOptions);
} catch (e) { if (e.status !== 1) throw e; }
const filterOverrides = filterKeys.split('\0').filter(Boolean).flatMap(key =>
  ['-c', key + (key.endsWith('.required') ? '=false' : '=')]);
const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...filterOverrides, ...args], gitOptions);
const initialHead = git('rev-parse', 'HEAD').trim();
const algorithm = git('rev-parse', '--show-object-format').trim();
if (!['sha1', 'sha256'].includes(algorithm)) throw new Error('Unsupported object format');
const files = new Map();
const identity = (p) => {
  try {
    const s = fs.lstatSync(p, { bigint: true });
    return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');
  } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; return undefined; }
};
const safePath = (p) => p && !p.includes('\0') && !p.includes('\ufffd') &&
  !path.isAbsolute(p) && p.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
for (const row of git('ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean)) {
  const tab = row.indexOf('\t');
  const [mode, type, oid] = row.slice(0, tab).split(' ');
  const p = row.slice(tab + 1);
  if (tab < 0 || !safePath(p)) throw new Error('Invalid tree path');
  if (type === 'blob') files.set(p, [mode + ':' + oid, identity(p)]);
}
const dirty = new Set([
  ...git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--').split('\0'),
  ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
].filter(Boolean));
let bytes = 0;
for (const p of dirty) {
  if (!safePath(p)) throw new Error('Invalid working-tree path');
  // Reject a symlinked parent, including links that happen to point inside root.
  let parent = root;
  let missingParent = false;
  for (const part of p.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe parent');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      missingParent = true;
      break;
    }
  }
  if (missingParent) { files.delete(p); continue; }
  let stat;
  try { stat = fs.lstatSync(p); }
  catch (e) { if (e.code !== 'ENOENT') throw e; files.delete(p); continue; }
  if (stat.isDirectory()) {
    // Gitlinks (submodules) are not files owned by this repository.
    if (files.has(p)) throw new Error('Tracked file replaced by directory');
    continue;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported file type');
  if (stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024)
    throw new Error('Snapshot byte limit');
  const fileIdentity = identity(p);
  let content;
  if (stat.isSymbolicLink()) content = Buffer.from(fs.readlinkSync(p));
  else {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== stat.size || before.ino !== stat.ino || before.dev !== stat.dev)
        throw new Error('File changed during snapshot');
      if (process.platform === 'linux' && !fs.readlinkSync('/proc/self/fd/' + fd).startsWith(root + '/'))
        throw new Error('File escaped workspace');
      content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const n = fs.readSync(fd, content, offset, content.length - offset, offset);
        if (!n) throw new Error('Short file read');
        offset += n;
      }
      const after = fs.fstatSync(fd);
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)
        throw new Error('File changed during snapshot');
    } finally { fs.closeSync(fd); }
  }
  const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644';
  const oid = crypto.createHash(algorithm).update('blob ' + content.length + '\0').update(content).digest('hex');
  if (fileIdentity !== identity(p)) throw new Error('File changed during snapshot');
  files.set(p, [mode + ':' + oid, fileIdentity]);
}
if (initialHead !== git('rev-parse', 'HEAD').trim()) throw new Error('HEAD changed during snapshot');
if (files.size > 30000) throw new Error('Snapshot file limit');
const result = JSON.stringify({ version: 1, files: [...files].map(([p, [hash, id]]) => [p, hash, id]), complete: true });
if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error('Snapshot output limit');
process.stdout.write(result);
`;

type Manifest = Map<string, { fingerprint: string; identity?: string }>;

function parseManifest(stdout: string): Manifest {
  if (Buffer.byteLength(stdout) > MAX_MANIFEST_BYTES) throw new Error('Manifest too large');
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object') throw new Error('Invalid manifest');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.complete !== true || !Array.isArray(record.files))
    throw new Error('Incomplete manifest');
  if (record.files.length > MAX_FILES) throw new Error('Too many manifest entries');
  const files: Manifest = new Map();
  for (const entry of record.files) {
    if (
      !Array.isArray(entry) ||
      (entry.length !== 2 && entry.length !== 3) ||
      typeof entry[0] !== 'string' ||
      !entry[0] ||
      entry[0].startsWith('/') ||
      entry[0].includes('\0') ||
      entry[0].split('/').some((part) => !part || ['.', '..', '.git'].includes(part)) ||
      typeof entry[1] !== 'string' ||
      !/^(100644|100755|120000):(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry[1]) ||
      (entry[2] !== undefined &&
        (typeof entry[2] !== 'string' || !/^-?\d+(?::-?\d+){5}$/.test(entry[2]))) ||
      files.has(entry[0])
    )
      throw new Error('Invalid manifest entry');
    files.set(entry[0], { fingerprint: entry[1], identity: entry[2] });
  }
  return files;
}

export interface WorkspaceFileObserverOptions {
  containerManager: ContainerManager;
  containerId: string;
  isCurrent(): boolean;
  emit(event: AgentFileChangeEvent): void;
  /** Log a bounded diagnostic, not remote stdout/stderr or source contents. */
  unavailable(): void;
}

/** One observer per agent run. Failed observations never replace a valid baseline. */
export function createWorkspaceFileObserver(options: WorkspaceFileObserverOptions) {
  let baseline: Manifest | undefined;
  let stopped = false;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let warned = false;
  const current = () => {
    try {
      return !stopped && options.isCurrent();
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!current()) throw new Error('File observation superseded');
  };
  const observe = async (): Promise<void> => {
    if (!current()) return;
    try {
      const result = await options.containerManager.execInContainer(
        options.containerId,
        ['node', '-e', WORKSPACE_FILE_SNAPSHOT_SCRIPT],
        { cwd: '/workspace', timeout: 10_000, assertCurrent },
      );
      if (!current()) return;
      if (result.exitCode !== 0) throw new Error('Snapshot failed');
      const next = parseManifest(result.stdout);
      const previous = baseline;
      if (!previous) {
        baseline = next;
        return;
      }
      const timestamp = new Date().toISOString();
      for (const [path, file] of next) {
        if (!current()) return;
        const prior = previous.get(path);
        // A commit can change Git's canonical representation without changing
        // the worktree bytes. Stable inode/ctime/mtime/size/mode prove that case.
        if (
          prior?.fingerprint === file.fingerprint ||
          (file.identity !== undefined && prior?.identity === file.identity)
        )
          continue;
        options.emit({
          type: 'file_change',
          timestamp,
          path,
          action: previous.has(path) ? 'modify' : 'create',
          source: 'workspace',
        });
      }
      for (const path of previous.keys()) {
        if (!current()) return;
        if (!next.has(path))
          options.emit({
            type: 'file_change',
            timestamp,
            path,
            action: 'delete',
            source: 'workspace',
          });
      }
      baseline = next;
    } catch {
      if (current() && !warned) {
        warned = true;
        try {
          options.unavailable();
        } catch {
          // Even an unavailable diagnostics sink must not fail the coding run.
        }
      }
    }
  };
  const reconcile = (): Promise<void> => {
    if (pending) return pending;
    pending = observe().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    /** Native file notifications are superseded only after a successful baseline. */
    get active() {
      return baseline !== undefined;
    },
    async start(): Promise<void> {
      await reconcile();
      // If baseline capture fails, retain native behavior for this run rather
      // than switching event sources mid-run and duplicating historical edits.
      if (baseline && current()) {
        timer = setInterval(() => void reconcile(), FILE_OBSERVATION_INTERVAL_MS);
        timer.unref();
      }
    },
    async finish(): Promise<void> {
      if (timer) clearInterval(timer);
      // An in-flight periodic scan can predate the last tool's changes. Drain
      // it, then take a fresh terminal snapshot before validation can begin.
      await pending;
      if (baseline && current()) await reconcile();
      stopped = true;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}

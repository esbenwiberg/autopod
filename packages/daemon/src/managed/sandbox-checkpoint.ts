import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { assertBoundedHeadPack } from './bounded-head-pack.js';
import { MAX_PRIVATE_HEAD_BYTES } from './private-head-export.js';
import { managedGit, managedGitBytes } from './source-git.js';

// Validate the committed tree without checking out files. Shared by offline
// preflight, daemon import and the final projection from the worker workspace.
export async function sandboxTreeEntries(
  repo: string,
  commit: string,
  cases: readonly string[] = [],
) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('sandbox-checkpoint-commit');
  const listing = await managedGit(repo, ['ls-tree', '-r', '-l', '-z', commit]);
  const entries = listing.split('\0').filter(Boolean);
  if (!entries.length || entries.length > 64) throw new Error('sandbox-checkpoint-size');
  let total = 0;
  const files = entries.map((entry) => {
    const match =
      /^100644 blob ([0-9a-f]{40}) +([0-9]+)\t([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$/.exec(
        entry,
      );
    if (
      !match ||
      match[0] !== entry ||
      match[3]!.length > 160 ||
      match[3]!.split('/').includes('node_modules')
    )
      throw new Error('sandbox-checkpoint-input');
    const size = Number(match[2]);
    total += size;
    if (!Number.isSafeInteger(total) || total > 1024 * 1024)
      throw new Error('sandbox-checkpoint-size');
    return { name: match[3]!, oid: match[1]!, size };
  });
  for (const dir of cases) {
    const selected = files.filter((f) => f.name.startsWith(dir + '/'));
    if (
      !selected.length ||
      selected.length > 16 ||
      selected.reduce((sum, f) => sum + f.size, 0) > 16384 ||
      selected.some((f) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(f.name.slice(dir.length + 1)))
    )
      throw new Error('inspection-case-files-invalid');
    const data: Record<string, string> = Object.create(null);
    for (const f of selected) {
      const b = await managedGitBytes(repo, ['cat-file', 'blob', f.oid]);
      if (b.length !== f.size || b.includes(0)) throw new Error('inspection-case-text-invalid');
      try {
        data[f.name.slice(dir.length + 1)] = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(b);
      } catch {
        throw new Error('inspection-case-text-invalid');
      }
    }
    // Match the compact UTF-8 input passed to the bounded report wrapper.
    if (Buffer.byteLength(JSON.stringify({ case: dir, files: data })) > 96 * 1024)
      throw new Error('inspection-case-text-invalid');
  }
  return files;
}

// Do not upload checkout extras; verify the actual worker bytes against the tree.
export async function withSandboxProjection<T>(
  workspace: string,
  commit: string,
  use: (dir: string, manifest: string) => Promise<T>,
) {
  const root = await realpath(workspace);
  const entries = await sandboxTreeEntries(root, commit);
  const dir = await mkdtemp(path.join(path.dirname(root), '.sandbox-projection-'));
  try {
    const manifest: Record<string, string> = Object.create(null);
    for (const { name, oid, size } of entries) {
      const file = path.join(root, name);
      if ((await realpath(file)) !== file) throw new Error('sandbox-checkpoint-link');
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const s = await fd.stat();
        if (!s.isFile() || s.size !== size) throw new Error('sandbox-checkpoint-size');
        bytes = Buffer.alloc(s.size);
        let pos = 0;
        while (pos < bytes.length) {
          const { bytesRead } = await fd.read(bytes, pos, bytes.length - pos, pos);
          if (!bytesRead) throw new Error('sandbox-checkpoint-size');
          pos += bytesRead;
        }
      } finally {
        await fd.close();
      }
      const blob = createHash('sha1')
        .update('blob ' + bytes.length + '\0')
        .update(bytes)
        .digest('hex');
      if (blob !== oid) throw new Error('sandbox-checkpoint-content');
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), bytes, { flag: 'wx', mode: 0o600 });
      manifest[name] = createHash('sha256').update(bytes).digest('hex');
    }
    for (const reserved of ['.agents', '.codex']) await mkdir(path.join(dir, reserved));
    return await use(dir, JSON.stringify(manifest));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fresh Git metadata derived from the accepted commit, not copied from a checkout.
 * Like report projection, this narrow lane refuses executable blobs and links. */
export async function withSandboxCodingProjection<T>(
  workspace: string,
  commit: string,
  use: (dir: string, manifest: string) => Promise<T>,
) {
  const source = await realpath(workspace);
  const entries = await sandboxTreeEntries(source, commit);
  const header = Buffer.from(`# v2 git bundle\n${commit} HEAD\n\n`);
  // Build a capped pack from only the selected revision. No fetch or clone can
  // write an oversized pack to the staging filesystem.
  const pack = await managedGitBytes(
    source,
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
    { input: commit + '\n', maxBuffer: MAX_PRIVATE_HEAD_BYTES - header.length, timeout: 12_000 },
  );
  const bundle = Buffer.concat([header, pack]);
  await assertBoundedHeadPack(bundle, commit);
  const dir = await mkdtemp(path.join(path.dirname(source), '.sandbox-coding-'));
  try {
    const input = path.join(dir, 'seed.bundle');
    await writeFile(input, bundle, { flag: 'wx', mode: 0o600 });
    await managedGit(dir, ['init', '--quiet', '--template=', '--object-format=sha1', '-b', 'main']);
    if ((await managedGit(dir, ['bundle', 'unbundle', input])) !== commit + ' HEAD')
      throw new Error('sandbox-coding-checkout-mismatch');
    await rm(input);
    await managedGit(dir, ['update-ref', '--no-deref', 'HEAD', commit]);
    await managedGit(dir, ['read-tree', commit]);

    const files: Record<string, string> = Object.create(null);
    for (const { name, oid, size } of entries) {
      const bytes = await managedGitBytes(dir, ['cat-file', 'blob', oid]);
      if (bytes.length !== size) throw new Error('sandbox-coding-checkout-mismatch');
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      files[name] = createHash('sha256').update(bytes).digest('hex');
    }
    for (const name of ['.agents', '.codex']) await mkdir(path.join(dir, name));
    const dirs = new Set(['.agents', '.codex', '.git']);
    for (const name of Object.keys(files)) {
      for (
        let parent = path.posix.dirname(name);
        parent !== '.';
        parent = path.posix.dirname(parent)
      )
        dirs.add(parent);
    }
    const maxMetadataFiles = 128;
    let total = 0;
    let count = 0;
    const visit = async (relative: string): Promise<void> => {
      for (const name of await readdir(path.join(dir, relative))) {
        const entry = relative + '/' + name;
        const file = path.join(dir, entry);
        const info = await lstat(file);
        if (++count > maxMetadataFiles) throw new Error('sandbox-coding-metadata-bound');
        if (info.isDirectory()) {
          dirs.add(entry);
          await visit(entry);
        } else {
          if (!info.isFile() || info.nlink !== 1 || info.size > MAX_PRIVATE_HEAD_BYTES - total)
            throw new Error('sandbox-coding-metadata-bound');
          total += info.size;
          files[entry] = createHash('sha256')
            .update(await readFile(file))
            .digest('hex');
        }
      }
    };
    await visit('.git');
    if (
      (await managedGit(dir, ['remote'])) !== '' ||
      (await managedGit(dir, ['for-each-ref'])) !== '' ||
      (await managedGit(dir, ['rev-parse', 'HEAD'])) !== commit
    )
      throw new Error('sandbox-coding-checkout-mismatch');
    const manifest = JSON.stringify({ files, dirs: [...dirs].sort() });
    if (Buffer.byteLength(manifest) > 64 * 1024) throw new Error('sandbox-coding-metadata-bound');
    return await use(dir, manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs as the unprivileged worker before the supervisor/provider is attached.
export const VERIFY_SANDBOX_PROJECTION = `import hashlib,json,os,stat,sys
root,raw,*mode=sys.argv[1:]
manifest=json.loads(raw)
want=manifest["files"] if mode==["coding"] else manifest
seen=set()
def check(ok):
 if not ok: raise ValueError("sandbox checkpoint verification failed")
dirs=set(manifest["dirs"]) if mode==["coding"] else {".agents",".codex"}
for name in want:
 parent=os.path.dirname(name)
 while parent: dirs.add(parent);parent=os.path.dirname(parent)
def visit(p,rel):
 st=os.lstat(p);check(stat.S_ISDIR(st.st_mode) and st.st_uid==0 and not st.st_mode & 0o022)
 for entry in os.scandir(p):
  n=rel+entry.name;s=entry.stat(follow_symlinks=False)
  if n in dirs:
   dirs.remove(n);visit(entry.path,n+"/")
  else:
   check(n in want and stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode & 0o133 and s.st_size<=1048576)
   with open(entry.path,"rb") as f: check(hashlib.sha256(f.read(1048577)).hexdigest()==want[n])
   seen.add(n)
check(os.geteuid()==1000 and os.path.realpath(root)==root)
parent=os.stat(os.path.dirname(root));check(parent.st_uid==0 and not parent.st_mode & 0o022)
visit(root,"");check(not dirs and seen==set(want))
print(hashlib.sha256(raw.encode()).hexdigest())`;

export async function allocateSandboxCheckpoint(
  manager: ContainerManager,
  config: ContainerSpawnConfig,
  cp: { repository: string; commit: string; coding?: true },
  beforeAllocate?: () => void,
) {
  const volumes = config.volumes ?? [],
    root = '/repositories/' + cp.repository;
  const inputs = volumes.filter((v) => v.container === root && v.readOnly === !cp.coding);
  if (
    inputs.length !== 1 ||
    volumes.length !== 2 ||
    !volumes.some((v) => v.container === '/output' && !v.readOnly) ||
    config.networkPolicyMode !== 'deny-all'
  )
    throw new Error('sandbox-checkpoint-scope');
  const project = cp.coding ? withSandboxCodingProjection : withSandboxProjection;
  return project(inputs[0]!.host, cp.commit, async (dir, manifest) => {
    beforeAllocate?.();
    const id = await manager.ensureManagedContainer!({
      ...config,
      // Lock the upload as root-owned read-only until the exact manifest is verified.
      // Only the runtime's subsequent writable preparation grants the worker ownership.
      volumes: volumes.map((v) => (v === inputs[0] ? { ...v, host: dir, readOnly: true } : v)),
    });
    const receipt = await manager.execInContainer(
      id,
      [
        'python3',
        ...(cp.coding ? ['-I'] : []),
        '-c',
        VERIFY_SANDBOX_PROJECTION,
        root,
        manifest,
        ...(cp.coding ? ['coding'] : []),
      ],
      cp.coding
        ? { user: 'autopod', timeout: 15_000, maxOutputBytes: 256, requireObservedExit: true }
        : { user: 'autopod' },
    );
    if (
      receipt.exitCode !== 0 ||
      (cp.coding && receipt.stderr !== '') ||
      receipt.stdout.trim() !== createHash('sha256').update(manifest).digest('hex')
    )
      throw new Error('sandbox-checkpoint-upload-unverified');
    return id;
  });
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
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

// Runs as the unprivileged worker before the supervisor/provider is attached.
export const VERIFY_SANDBOX_PROJECTION = `import hashlib,json,os,stat,sys
root,raw=sys.argv[1:]
want=json.loads(raw);seen=set()
def check(ok):
 if not ok: raise ValueError("sandbox checkpoint verification failed")
dirs={".agents",".codex"}
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
  cp: { repository: string; commit: string },
  beforeAllocate?: () => void,
) {
  const volumes = config.volumes ?? [],
    root = '/repositories/' + cp.repository;
  const inputs = volumes.filter((v) => v.container === root && v.readOnly);
  if (
    inputs.length !== 1 ||
    volumes.length !== 2 ||
    !volumes.some((v) => v.container === '/output' && !v.readOnly) ||
    config.networkPolicyMode !== 'deny-all'
  )
    throw new Error('sandbox-checkpoint-scope');
  return withSandboxProjection(inputs[0]!.host, cp.commit, async (dir, manifest) => {
    beforeAllocate?.();
    const id = await manager.ensureManagedContainer!({
      ...config,
      volumes: volumes.map((v) => (v === inputs[0] ? { ...v, host: dir } : v)),
    });
    const receipt = await manager.execInContainer(
      id,
      ['python3', '-c', VERIFY_SANDBOX_PROJECTION, root, manifest],
      { user: 'autopod' },
    );
    if (
      receipt.exitCode !== 0 ||
      receipt.stdout.trim() !== createHash('sha256').update(manifest).digest('hex')
    )
      throw new Error('sandbox-checkpoint-upload-unverified');
    return id;
  });
}

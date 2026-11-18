import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { managedGit } from './source-git.js';

// Restricted report input only. Don't upload .git, unrelated history, checkout
// extras, links or dependencies. Compare the copied bytes with pinned Git blobs.
export async function withSandboxProjection<T>(
  workspace: string,
  commit: string,
  use: (dir: string, manifest: string) => Promise<T>,
) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('sandbox-checkpoint-commit');
  const root = await realpath(workspace);
  const listing = await managedGit(root, ['ls-tree', '-r', '-z', commit]);
  const entries = listing.split('\0').filter(Boolean);
  if (!entries.length || entries.length > 64) throw new Error('sandbox-checkpoint-size');
  const dir = await mkdtemp(path.join(path.dirname(root), '.sandbox-projection-'));
  try {
    const manifest: Record<string, string> = Object.create(null);
    let total = 0;
    for (const entry of entries) {
      const match =
        /^100644 blob ([0-9a-f]{40})\t([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$/.exec(
          entry,
        );
      if (
        !match ||
        match[0] !== entry ||
        match[2]!.length > 160 ||
        match[2]!.split('/').includes('node_modules')
      )
        throw new Error('sandbox-checkpoint-input');
      const name = match[2]!,
        file = path.join(root, name);
      if ((await realpath(file)) !== file) throw new Error('sandbox-checkpoint-link');
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const s = await fd.stat();
        total += s.size;
        if (!s.isFile() || total > 1024 * 1024) throw new Error('sandbox-checkpoint-size');
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
      if (blob !== match[1]) throw new Error('sandbox-checkpoint-content');
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

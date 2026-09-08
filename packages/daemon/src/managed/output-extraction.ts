import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactOutput } from '@autopod/shared';
import tar from 'tar-stream';
import { safeRelative } from './artifact-collector.js';
import { sha256 } from './canonical.js';

async function requireEmptyStaging(destination: string): Promise<void> {
  // The service creates a fresh staging directory; never extract into a preexisting tree.
  let parent = path.resolve(path.dirname(destination));
  while (parent !== path.dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('artifact-unsafe-staging');
    parent = path.dirname(parent);
  }
  await mkdir(destination, { mode: 0o700 });
}

/** Docker getArchive data is untrusted. Reject links before any filesystem writes. */
export async function extractManagedDockerOutput(
  stream: NodeJS.ReadableStream,
  destination: string,
  output: ArtifactOutput,
): Promise<void> {
  await requireEmptyStaging(destination);
  const extract = tar.extract();
  let count = 0;
  let total = 0;
  const seen = new Set<string>();
  const done = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    extract.on('error', reject);
    extract.on('finish', resolve);
    extract.on('entry', (header, entry, next) => {
      entry.on('error', reject);
      if ((header.name === 'output' || header.name === 'output/') && header.type === 'directory') {
        entry.resume();
        entry.on('end', next);
        return;
      }
      const name = header.name.startsWith('output/') ? header.name.slice(7).replace(/\/$/, '') : '';
      if (
        !safeRelative(name) ||
        seen.has(name) ||
        !['file', 'directory'].includes(header.type ?? '') ||
        header.linkname
      ) {
        entry.resume();
        extract.destroy(new Error('artifact-unsafe-entry'));
        return;
      }
      seen.add(name);
      total += header.size ?? 0;
      if (
        ++count > output.limits.maxFiles * 2 + 100 ||
        (header.size ?? 0) > output.limits.maxFileBytes ||
        total > output.limits.maxTotalBytes
      ) {
        entry.resume();
        extract.destroy(new Error('artifact-extraction-limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on('data', (chunk) => {
        size += chunk.length;
        if (size > (header.size ?? 0)) extract.destroy(new Error('artifact-extraction-limit'));
        else chunks.push(Buffer.from(chunk));
      });
      entry.on('end', () => {
        const target = path.join(destination, name);
        const write = async () => {
          if (header.type === 'directory') await mkdir(target, { recursive: true });
          else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
          }
        };
        write().then(next, (error) => extract.destroy(error as Error));
      });
    });
  });
  stream.pipe(extract);
  try {
    await done;
  } finally {
    const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
    destroyable.destroy?.();
  }
}

/** Trusted runtime-side stat helper preserves link/type information the files API omits. */
export const SANDBOX_OUTPUT_INVENTORY = `import os,stat,json,hashlib,sys
root='/output'
files=[]
limit=int(sys.argv[1]); per_file=int(sys.argv[2]); total_limit=int(sys.argv[3]); total=0
if not os.path.isdir(root) or os.path.islink(root): raise ValueError('unsafe-output-root')
for base,dirs,names in os.walk(root,followlinks=False):
 for name in dirs+names:
  p=os.path.join(base,name); s=os.lstat(p)
  if stat.S_ISLNK(s.st_mode): raise ValueError('unsafe-entry')
  if stat.S_ISDIR(s.st_mode): continue
  if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1: raise ValueError('unsafe-entry')
  if len(files)>=limit or s.st_size>per_file: raise ValueError('output-limit')
  total+=s.st_size
  if total>total_limit: raise ValueError('output-limit')
  with open(p,'rb') as f: checksum=hashlib.sha256(f.read()).hexdigest()
  files.append({'path':os.path.relpath(p,root),'size':s.st_size,'sha256':'sha256:'+checksum})
print(json.dumps(files,sort_keys=True,separators=(',',':')))
`;

export async function extractManagedSandboxOutput(
  inventory: unknown,
  read: (name: string) => Promise<Buffer>,
  destination: string,
  output: ArtifactOutput,
): Promise<void> {
  if (!Array.isArray(inventory) || inventory.length > output.limits.maxFiles)
    throw new Error('artifact-invalid-inventory');
  const seen = new Set<string>();
  let total = 0;
  const files: { path: string; bytes: Buffer }[] = [];
  for (const raw of inventory) {
    const item = raw as { path: string; size: number; sha256: string };
    if (
      !item ||
      typeof item.path !== 'string' ||
      !safeRelative(item.path) ||
      seen.has(item.path) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > output.limits.maxFileBytes
    )
      throw new Error('artifact-invalid-inventory');
    total += item.size;
    if (total > output.limits.maxTotalBytes) throw new Error('artifact-invalid-inventory');
    seen.add(item.path);
    const bytes = await read(`/output/${item.path}`);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256)
      throw new Error('artifact-output-changed');
    files.push({ path: item.path, bytes });
  }
  await requireEmptyStaging(destination);
  for (const file of files) {
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
}

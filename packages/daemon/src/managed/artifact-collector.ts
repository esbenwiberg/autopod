import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ArtifactOutput } from '@autopod/shared';
import tar from 'tar-stream';
import { sha256 } from './canonical.js';

export interface CollectedOutput {
  files: { path: string; size: number; sha256: string; mediaType: string }[];
  bundle: Buffer;
  totalBytes: number;
}

export function safeRelative(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.split('/').some((part) => part === '..' || part === '.' || part === '') &&
    !path.isAbsolute(name)
  );
}

function matches(pattern: string, name: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (pattern.slice(i, i + 3) === '**/') {
      regex += '(?:.*/)?';
      i += 2;
    } else if (pattern.slice(i, i + 2) === '**') {
      regex += '.*';
      i++;
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(name);
}

/** Call only after the runtime confirms the writer exited and staging is frozen. */
export async function collectOutput(
  root: string,
  contract: ArtifactOutput,
): Promise<CollectedOutput | null> {
  if (contract.mode === 'none') return null;
  let rootStat: import('node:fs').Stats;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && contract.mode === 'optional')
      return null;
    throw new Error('artifact-output-missing');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('artifact-unsafe-root');
  // No symlinked ancestors, including the trusted staging root.
  let ancestor = path.resolve(root);
  while (ancestor !== path.dirname(ancestor)) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('artifact-unsafe-root');
    ancestor = path.dirname(ancestor);
  }
  const entries: { path: string; bytes: Buffer }[] = [];
  let totalBytes = 0;
  let seenFiles = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(relative)) throw new Error('artifact-unsafe-path');
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('artifact-unsafe-entry');
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) throw new Error('artifact-unsafe-entry');
      // Bound traversal even for excluded files. Exclusions cannot hide unsafe entries.
      if (++seenFiles > contract.limits.maxFiles) throw new Error('artifact-count-limit');
      if (info.size > contract.limits.maxFileBytes) throw new Error('artifact-file-limit');
      if (
        !contract.include.some((pattern) => matches(pattern, relative)) ||
        contract.exclude.some((pattern) => matches(pattern, relative))
      )
        continue;
      if (totalBytes + info.size > contract.limits.maxTotalBytes)
        throw new Error('artifact-total-limit');
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.ino !== info.ino ||
          before.dev !== info.dev ||
          before.size !== info.size
        ) {
          throw new Error('artifact-output-changed');
        }
        bytes = await file.readFile();
        const after = await file.stat();
        if (
          bytes.length !== info.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          throw new Error('artifact-output-changed');
        }
      } finally {
        await file.close();
      }
      entries.push({ path: relative, bytes });
      totalBytes += bytes.length;
    }
  };
  await visit(root, '');
  if (
    contract.requiredPaths.some((required) => !entries.some((entry) => entry.path === required))
  ) {
    throw new Error('artifact-required-path-missing');
  }
  if (!entries.length) {
    if (contract.mode === 'required') throw new Error('artifact-required-empty');
    return null;
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        pack.destroy(new Error('artifact-nonbinary-chunk'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const writeEntries = async () => {
    for (const entry of entries) {
      await new Promise<void>((resolve, reject) => {
        const stream = pack.entry(
          {
            name: entry.path,
            size: entry.bytes.length,
            type: 'file',
            mode: 0o444,
            uid: 0,
            gid: 0,
            uname: '',
            gname: '',
            mtime: new Date(0),
          },
          entry.bytes,
          (error) => (error ? reject(error) : resolve()),
        );
        stream.on('error', reject);
      });
    }
    pack.finalize();
  };
  // Observe both promises immediately: a packing failure may happen while an
  // entry callback is pending. Neither rejection may escape as unhandled.
  const [, bytes] = await Promise.all([writeEntries(), completed]);
  const bundle = gzipSync(bytes, { level: 9 });
  return {
    files: entries.map((entry) => ({
      path: entry.path,
      size: entry.bytes.length,
      sha256: sha256(entry.bytes),
      mediaType: entry.path.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
    })),
    bundle,
    totalBytes,
  };
}

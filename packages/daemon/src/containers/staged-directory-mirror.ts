import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';

function pathExists(location: string): boolean {
  try {
    lstatSync(location);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeExtractPath(pathname: string): string {
  return pathname.split('/').filter(Boolean).join('/');
}

export function isExcludedPath(relPath: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  const normalizedRel = normalizeExtractPath(relPath);
  const segments = normalizedRel.split('/');
  return excludes.some((exclude) => {
    const normalizedExclude = normalizeExtractPath(exclude);
    if (!normalizedExclude) return false;
    if (!normalizedExclude.includes('/')) {
      return segments.includes(normalizedExclude);
    }
    return normalizedRel === normalizedExclude || normalizedRel.startsWith(`${normalizedExclude}/`);
  });
}

function collectRelativeEntries(
  root: string,
  excludes?: string[],
  skipTopLevel?: string,
): string[] {
  const entries: string[] = [];

  function walk(relativeDir: string): void {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    for (const dirent of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relPath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const topLevel = relPath.split('/')[0];
      if (topLevel === skipTopLevel || isExcludedPath(relPath, excludes)) {
        continue;
      }
      entries.push(relPath);
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        walk(relPath);
      }
    }
  }

  walk('');
  return entries;
}

export function mirrorStagedDirectory(
  stagingPath: string,
  hostPath: string,
  excludes?: string[],
  stagingBase?: string,
): void {
  const directories: Array<{ target: string; mode: number; atime: Date; mtime: Date }> = [];
  function containsExcluded(relative: string): boolean {
    if (!excludes?.length) return false;
    for (const entry of readdirSync(join(hostPath, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (isExcludedPath(child, excludes)) return true;
      if (entry.isDirectory() && !entry.isSymbolicLink() && containsExcluded(child)) return true;
    }
    return false;
  }
  // Copy directories ourselves: Node's recursive cp cannot replace a directory
  // with a symlink and its native directory path can materialize directory links.
  // Never follow an old destination link into another workspace/location.
  function copyEntry(relative: string): void {
    if (isExcludedPath(relative, excludes)) return;
    const source = join(stagingPath, relative);
    const target = join(hostPath, relative);
    const sourceStat = lstatSync(source);
    if (sourceStat.isDirectory()) {
      if (pathExists(target) && !lstatSync(target).isDirectory())
        rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      if (!lstatSync(target).isDirectory())
        throw new Error('Mirror destination is not a directory');
      chmodSync(target, (sourceStat.mode & 0o777) | 0o700);
      directories.push({
        target,
        mode: sourceStat.mode & 0o777,
        atime: sourceStat.atime,
        mtime: sourceStat.mtime,
      });
      for (const entry of readdirSync(source)) copyEntry(`${relative}/${entry}`);
    } else {
      // Unlink only the selected destination entry; preserve its former target,
      // and avoid truncating any external hardlink alias of an old regular file.
      if (pathExists(target) && lstatSync(target).isDirectory() && containsExcluded(relative))
        throw new Error('Mirror type change would remove excluded destination entries');
      rmSync(target, { recursive: true, force: true });
      if (sourceStat.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target);
      } else {
        cpSync(source, target, { force: true, preserveTimestamps: true });
      }
    }
  }
  try {
    for (const entry of readdirSync(stagingPath)) copyEntry(entry);
    const hostEntries = collectRelativeEntries(hostPath, excludes, stagingBase).sort(
      (a, b) => b.length - a.length,
    );
    for (const relative of hostEntries) {
      if (!pathExists(join(stagingPath, relative))) {
        const target = join(hostPath, relative);
        if (lstatSync(target).isDirectory() && containsExcluded(relative)) continue;
        rmSync(target, { recursive: true, force: true });
      }
    }
  } finally {
    // Prune while owned directories are writable, then restore their exact modes.
    for (const directory of directories.reverse()) {
      utimesSync(directory.target, directory.atime, directory.mtime);
      chmodSync(directory.target, directory.mode);
    }
  }
}

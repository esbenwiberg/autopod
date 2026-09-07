import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Content identity for the implementation and its locked build dependencies. */
export function hashImplementationInputs(root: string, files: string[]): string | null {
  try {
    if (files.length === 0 || files.length > 100000) return null;
    const canonicalRoot = realpathSync(root);
    const hash = createHash('sha256').update(`autopod-build-inputs-v1\0${process.version}\0`);
    let totalBytes = 0;
    for (const file of [...new Set(files)].sort()) {
      const path = resolve(root, file);
      const within = relative(canonicalRoot, realpathSync(path));
      if (
        isAbsolute(file) ||
        within === '..' ||
        within.startsWith(`..${sep}`) ||
        isAbsolute(within)
      )
        return null;
      const stat = lstatSync(path);
      totalBytes += stat.size;
      if (!stat.isFile() || totalBytes > 64 * 1024 ** 2) return null;
      hash.update(JSON.stringify([file, stat.mode, stat.size]));
      hash.update(readFileSync(path));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
export function collectImplementationIdentity(): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        'packages/daemon/src',
        'packages/shared/src',
        'packages/validator/src',
        'packages/escalation-mcp/src',
        'packages/daemon/tsup.config.ts',
        'packages/daemon/package.json',
        'packages/shared/package.json',
        'packages/validator/package.json',
        'packages/escalation-mcp/package.json',
        'packages/daemon/tsconfig.json',
        'packages/shared/tsconfig.json',
        'packages/validator/tsconfig.json',
        'packages/escalation-mcp/tsconfig.json',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.base.json',
        'turbo.json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 10000000 },
    )
      .split('\0')
      .filter(Boolean);
    return hashImplementationInputs(root, files);
  } catch {
    return null;
  }
}

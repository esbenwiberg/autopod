import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';

/** Resolve existing ancestors too: realpath alone misses new paths below symlinks. */
export function retainedPathIdentity(location: string): string {
  // Keep '..' until the filesystem resolves it; lexical normalization before
  // following a symlink can identify a completely different directory.
  let cursor = path.isAbsolute(location) ? location : `${process.cwd()}${path.sep}${location}`;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cursor), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // A dangling link is unknown authority, not a missing ordinary directory.
        try {
          if (lstatSync(cursor).isSymbolicLink()) break;
        } catch (statError) {
          if (!['ENOENT', 'ENOTDIR'].includes((statError as NodeJS.ErrnoException).code ?? ''))
            break;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        suffix.unshift(path.basename(cursor));
        cursor = parent;
        continue;
      }
      break;
    }
  }
  throw new AutopodError(
    'Retained source path identity is unavailable; no filesystem mutation is authorized.',
    'RETAINED_FINALIZATION_BLOCKED',
    409,
  );
}

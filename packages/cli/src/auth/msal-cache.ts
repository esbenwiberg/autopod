import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { getConfigDir } from '../config/config-store.js';

const MSAL_CACHE_FILE = 'msal-cache.json';

export function getMsalCachePath(): string {
  return path.join(getConfigDir(), MSAL_CACHE_FILE);
}

export function getFallbackMsalCachePath(): string {
  const namespace = createHash('sha256').update(getConfigDir()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'autopod-auth', namespace, MSAL_CACHE_FILE);
}

function cacheCandidates(primaryPath: string, fallbackPath: string): string[] {
  return [primaryPath, fallbackPath]
    .map((cachePath) => {
      try {
        return { cachePath, mtimeMs: fs.statSync(cachePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map(({ cachePath }) => cachePath);
}

function isReadOnlyPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function writeCache(cachePath: string, serialized: string): void {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { mode: 0o600 });
    fs.renameSync(temporaryPath, cachePath);
    fs.chmodSync(cachePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write or rename failure.
    }
    throw error;
  }
}

export class MsalFileCachePlugin implements ICachePlugin {
  constructor(
    private readonly cachePath = getMsalCachePath(),
    private readonly fallbackPath = getFallbackMsalCachePath(),
  ) {}

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    for (const cachePath of cacheCandidates(this.cachePath, this.fallbackPath)) {
      try {
        context.tokenCache.deserialize(fs.readFileSync(cachePath, 'utf-8'));
        return;
      } catch {
        // Try the other copy. A corrupt or unreadable cache must not prevent login.
      }
    }
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (!context.cacheHasChanged) return;

    try {
      writeCache(this.cachePath, context.tokenCache.serialize());
    } catch (error) {
      if (!isReadOnlyPathError(error)) throw error;
      writeCache(this.fallbackPath, context.tokenCache.serialize());
    }
  }
}

export function deleteMsalCache(
  cachePath = getMsalCachePath(),
  fallbackPath = getFallbackMsalCachePath(),
): void {
  for (const candidate of new Set([cachePath, fallbackPath])) {
    try {
      fs.unlinkSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !isReadOnlyPathError(error)) throw error;
    }
  }
}

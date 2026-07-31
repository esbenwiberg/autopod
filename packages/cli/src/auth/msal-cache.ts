import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { getConfigDir } from '../config/config-store.js';

const MSAL_CACHE_FILE = 'msal-cache.json';

export function getMsalCachePath(): string {
  return path.join(getConfigDir(), MSAL_CACHE_FILE);
}

export class MsalFileCachePlugin implements ICachePlugin {
  constructor(private readonly cachePath = getMsalCachePath()) {}

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    try {
      context.tokenCache.deserialize(fs.readFileSync(this.cachePath, 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt or unreadable cache must not prevent an explicit login.
        // MSAL will replace it after the cache changes.
      }
    }
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (!context.cacheHasChanged) return;

    const dir = path.dirname(this.cachePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, context.tokenCache.serialize(), { mode: 0o600 });
      fs.renameSync(temporaryPath, this.cachePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write or rename failure.
      }
      throw error;
    }
  }
}

export function deleteMsalCache(cachePath = getMsalCachePath()): void {
  try {
    fs.unlinkSync(cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

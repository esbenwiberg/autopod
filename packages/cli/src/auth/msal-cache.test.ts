import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TokenCacheContext } from '@azure/msal-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MsalFileCachePlugin, deleteMsalCache } from './msal-cache.js';

const temporaryDirectories: string[] = [];

function cacheContext(options: {
  changed?: boolean;
  serialized?: string;
  deserialize?: (value: string) => void;
}): TokenCacheContext {
  return {
    cacheHasChanged: options.changed ?? false,
    tokenCache: {
      serialize: () => options.serialized ?? '{}',
      deserialize: options.deserialize ?? (() => undefined),
    },
  } as TokenCacheContext;
}

function temporaryCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-msal-cache-'));
  temporaryDirectories.push(dir);
  return path.join(dir, 'nested', 'msal-cache.json');
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MsalFileCachePlugin', () => {
  it('persists changed MSAL state with owner-only permissions', async () => {
    const cachePath = temporaryCachePath();
    const plugin = new MsalFileCachePlugin(cachePath);

    await plugin.afterCacheAccess(
      cacheContext({ changed: true, serialized: '{"refresh":"token"}' }),
    );

    expect(fs.readFileSync(cachePath, 'utf-8')).toBe('{"refresh":"token"}');
    expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it('loads persisted state into a new MSAL process', async () => {
    const cachePath = temporaryCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{"account":"cached"}');
    const deserialize = vi.fn();

    await new MsalFileCachePlugin(cachePath).beforeCacheAccess(cacheContext({ deserialize }));

    expect(deserialize).toHaveBeenCalledWith('{"account":"cached"}');
  });

  it('does not rewrite unchanged state', async () => {
    const cachePath = temporaryCachePath();

    await new MsalFileCachePlugin(cachePath).afterCacheAccess(cacheContext({ changed: false }));

    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('deletes persisted refresh state on logout', () => {
    const cachePath = temporaryCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, 'cached');

    deleteMsalCache(cachePath);

    expect(fs.existsSync(cachePath)).toBe(false);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AuthToken } from '@autopod/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteCredentials, readCredentials, writeCredentials } from './credential-store.js';

const temporaryDirectories: string[] = [];

function token(accessToken: string, expiresAt = '2099-01-01T00:00:00.000Z'): AuthToken {
  return {
    accessToken,
    refreshToken: '',
    expiresAt,
    userId: 'user-1',
    displayName: 'Test User',
    email: 'test@example.com',
    roles: [],
  };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('credential-store', () => {
  it('uses a private fallback when the durable credential path is read-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-creds-readonly-'));
    temporaryDirectories.push(root);
    const readOnlyDir = path.join(root, 'readonly');
    const primaryPath = path.join(readOnlyDir, 'credentials.json');
    const fallbackPath = path.join(root, 'fallback', 'credentials.json');
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o500);

    writeCredentials(token('fresh'), { primaryPath, fallbackPath });

    expect(readCredentials({ primaryPath, fallbackPath })?.accessToken).toBe('fresh');
    expect(fs.statSync(path.dirname(fallbackPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fallbackPath).mode & 0o777).toBe(0o600);
  });

  it('prefers the newest credential copy and deletes both copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-creds-newest-'));
    temporaryDirectories.push(root);
    const primaryPath = path.join(root, 'primary.json');
    const fallbackPath = path.join(root, 'fallback.json');
    fs.writeFileSync(primaryPath, JSON.stringify(token('old')));
    fs.writeFileSync(fallbackPath, JSON.stringify(token('new')));
    const later = new Date(Date.now() + 1_000);
    fs.utimesSync(fallbackPath, later, later);

    expect(readCredentials({ primaryPath, fallbackPath })?.accessToken).toBe('new');
    deleteCredentials({ primaryPath, fallbackPath });
    expect(fs.existsSync(primaryPath)).toBe(false);
    expect(fs.existsSync(fallbackPath)).toBe(false);
  });
});

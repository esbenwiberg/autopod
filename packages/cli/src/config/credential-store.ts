import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuthToken } from '@autopod/shared';
import { getConfigDir } from './config-store.js';

const CREDENTIALS_FILE = 'credentials.json';

function getCredentialsPath(): string {
  return path.join(getConfigDir(), CREDENTIALS_FILE);
}

export function readCredentials(): AuthToken | null {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const token = JSON.parse(raw) as AuthToken;

    // Check if expired
    if (new Date(token.expiresAt) <= new Date()) {
      return null;
    }

    return token;
  } catch {
    return null;
  }
}

export function writeCredentials(token: AuthToken): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const credPath = getCredentialsPath();
  fs.writeFileSync(credPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): void {
  const credPath = getCredentialsPath();
  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
  }
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AuthToken } from '@autopod/shared';
import { getConfigDir } from './config-store.js';

const CREDENTIALS_FILE = 'credentials.json';

interface CredentialPathOptions {
  primaryPath?: string;
  fallbackPath?: string;
}

interface ReadCredentialOptions extends CredentialPathOptions {
  allowExpired?: boolean;
}

function getCredentialsPath(): string {
  return path.join(getConfigDir(), CREDENTIALS_FILE);
}

function getFallbackCredentialsPath(): string {
  const namespace = createHash('sha256').update(getConfigDir()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'autopod-auth', namespace, CREDENTIALS_FILE);
}

function resolvePaths(options: CredentialPathOptions = {}): [string, string] {
  return [
    options.primaryPath ?? getCredentialsPath(),
    options.fallbackPath ?? getFallbackCredentialsPath(),
  ];
}

function readCandidate(filePath: string): { token: AuthToken; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return {
      token: JSON.parse(raw) as AuthToken,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch {
    return null;
  }
}

export function readCredentials(options: ReadCredentialOptions = {}): AuthToken | null {
  const candidates = resolvePaths(options)
    .map(readCandidate)
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { token } of candidates) {
    if (!options.allowExpired && new Date(token.expiresAt) <= new Date()) {
      continue;
    }
    return token;
  }

  return null;
}

function writeCredentialFile(filePath: string, token: AuthToken): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
}

function isReadOnlyPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

export function writeCredentials(token: AuthToken, options: CredentialPathOptions = {}): void {
  const [primaryPath, fallbackPath] = resolvePaths(options);
  try {
    writeCredentialFile(primaryPath, token);
  } catch (error) {
    if (!isReadOnlyPathError(error)) throw error;
    writeCredentialFile(fallbackPath, token);
  }
}

export function deleteCredentials(options: CredentialPathOptions = {}): void {
  for (const filePath of new Set(resolvePaths(options))) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !isReadOnlyPathError(error)) throw error;
    }
  }
}

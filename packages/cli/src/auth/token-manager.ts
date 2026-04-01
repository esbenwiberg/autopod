import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthError } from '@autopod/shared';
import type { AuthToken } from '@autopod/shared';
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../config/credential-store.js';
import { MsalClient } from './msal-client.js';

/** Read the daemon's dev token written to ~/.autopod/dev-token on first run. */
function readDevToken(): string | null {
  try {
    return readFileSync(join(homedir(), '.autopod', 'dev-token'), 'utf-8').trim();
  } catch {
    return null;
  }
}

let msalClient: MsalClient | null = null;

export function initMsal(clientId: string, tenantId: string): void {
  msalClient = new MsalClient(clientId, tenantId);
}

export function getMsalClient(): MsalClient {
  if (!msalClient) {
    throw new AuthError(
      'MSAL not initialized. Set AUTOPOD_CLIENT_ID and AUTOPOD_TENANT_ID, then run: ap login',
    );
  }
  return msalClient;
}

export async function getToken(): Promise<string> {
  const creds = readCredentials();
  if (!creds) {
    const devToken = readDevToken();
    if (devToken) return devToken;
    throw new AuthError('Not authenticated. Run: ap login');
  }

  // Check if token is still valid (with 5 min buffer)
  const expiresAt = new Date(creds.expiresAt);
  const buffer = 5 * 60 * 1000;
  if (expiresAt.getTime() - buffer > Date.now()) {
    return creds.accessToken;
  }

  // Try silent refresh
  const refreshed = await refresh();
  if (refreshed) {
    return refreshed.accessToken;
  }

  throw new AuthError('Token expired and refresh failed. Run: ap login');
}

export async function refresh(): Promise<AuthToken | null> {
  if (!msalClient) return null;

  try {
    const accounts = await msalClient.getAccounts();
    const account = accounts[0];
    if (!account) return null;

    const token = await msalClient.refreshToken(account);
    if (token) {
      writeCredentials(token);
      return token;
    }
  } catch {
    // Silent refresh failed
  }

  return null;
}

export function clear(): void {
  deleteCredentials();
}

export function getCurrentUser(): AuthToken | null {
  return readCredentials();
}

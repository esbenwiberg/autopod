#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const DEFAULT_DAEMON_URL = 'https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com';
const DEFAULT_DIRECT_URL = 'http://autopod-daemon-ewi.swedencentral.cloudapp.azure.com:3100';
const DEFAULT_APP_ID = '3ccd604d-3887-4309-9988-739358fb5811';
const DEFAULT_REDIRECT_URI = 'msauth.com.autopod.desktop://auth';
const DEFAULT_SUBSCRIPTION_ID = '06bb959b-9458-41a6-bdf5-77cc12feaab9';
const DEFAULT_RESOURCE_GROUP = 'ewi-sandboxes';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  printHelp();
  process.exit(0);
}

const options = {
  daemonUrl: env('HOSTED_DAEMON_URL', DEFAULT_DAEMON_URL).replace(/\/+$/, ''),
  directUrl: env('HOSTED_DAEMON_DIRECT_URL', DEFAULT_DIRECT_URL).replace(/\/+$/, ''),
  appId: env('ENTRA_CLIENT_ID', DEFAULT_APP_ID),
  redirectUri: env('ENTRA_DESKTOP_REDIRECT_URI', DEFAULT_REDIRECT_URI),
  subscriptionId: env('AZURE_SUBSCRIPTION_ID', DEFAULT_SUBSCRIPTION_ID),
  resourceGroup: env('AZURE_RESOURCE_GROUP', DEFAULT_RESOURCE_GROUP),
  timeoutMs: Number.parseInt(env('HOSTED_DAEMON_CHECK_TIMEOUT_MS', '12000'), 10),
  json: args.has('--json'),
  skipAuth: args.has('--skip-auth'),
  skipAzure: args.has('--skip-azure'),
};

const results = [];

await checkHttpsHealth();
await checkAuthenticatedStats();
await checkDirectPortClosed();
checkEntraRedirectUri();
checkAzureResourceGroupAccess();

if (options.json) {
  console.log(JSON.stringify({ ok: !results.some((r) => r.status === 'fail'), results }, null, 2));
} else {
  printResults(results);
}

process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);

async function checkHttpsHealth() {
  await recordAsync('https-health', async () => {
    const response = await fetchWithTimeout(`${options.daemonUrl}/health`);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${truncate(text)}`);
    }
    const body = JSON.parse(text);
    if (body.status !== 'ok') {
      throw new Error(`Unexpected body: ${truncate(text)}`);
    }
    return `status=ok version=${body.version ?? 'unknown'}`;
  });
}

async function checkAuthenticatedStats() {
  if (options.skipAuth) {
    recordSkip('authenticated-stats', 'skipped by --skip-auth');
    return;
  }

  await recordAsync('authenticated-stats', async () => {
    const token = readDaemonToken();
    const response = await fetchWithTimeout(`${options.daemonUrl}/pods/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${truncate(text)}`);
    }
    JSON.parse(text);
    return 'authenticated /pods/stats returned JSON';
  });
}

async function checkDirectPortClosed() {
  await recordAsync('direct-3100-closed', async () => {
    try {
      const response = await fetchWithTimeout(`${options.directUrl}/health`);
      throw new Error(`direct 3100 is reachable with HTTP ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('direct 3100 is reachable')) {
        throw err;
      }
      return 'direct 3100 was not reachable from this client';
    }
  });
}

function checkEntraRedirectUri() {
  if (options.skipAzure) {
    recordSkip('entra-native-redirect', 'skipped by --skip-azure');
    return;
  }

  recordSync('entra-native-redirect', () => {
    const raw = execFileSync(
      'az',
      [
        'ad',
        'app',
        'show',
        '--id',
        options.appId,
        '--query',
        'publicClient.redirectUris',
        '-o',
        'json',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    const redirectUris = JSON.parse(raw);
    if (!Array.isArray(redirectUris) || !redirectUris.includes(options.redirectUri)) {
      throw new Error(`missing ${options.redirectUri}; current=${JSON.stringify(redirectUris)}`);
    }
    return `registered ${options.redirectUri}`;
  });
}

function checkAzureResourceGroupAccess() {
  if (options.skipAzure) {
    recordSkip('azure-resource-group-access', 'skipped by --skip-azure');
    return;
  }

  recordSync('azure-resource-group-access', () => {
    const id = execFileSync(
      'az',
      [
        'group',
        'show',
        '--subscription',
        options.subscriptionId,
        '-n',
        options.resourceGroup,
        '--query',
        'id',
        '-o',
        'tsv',
      ],
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    return id;
  });
}

async function recordAsync(name, fn) {
  try {
    results.push({ name, status: 'pass', detail: await fn() });
  } catch (err) {
    results.push({ name, status: 'fail', detail: errorMessage(err) });
  }
}

function recordSync(name, fn) {
  try {
    results.push({ name, status: 'pass', detail: fn() });
  } catch (err) {
    results.push({ name, status: 'fail', detail: errorMessage(err) });
  }
}

function recordSkip(name, detail) {
  results.push({ name, status: 'skip', detail });
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

function readDaemonToken() {
  if (process.env.AUTOPOD_DAEMON_TOKEN) return process.env.AUTOPOD_DAEMON_TOKEN.trim();
  return execFileSync('ap', ['token'], { encoding: 'utf8', timeout: 15000 }).trim();
}

function printResults(items) {
  for (const item of items) {
    const marker = item.status === 'pass' ? 'PASS' : item.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`${marker} ${item.name}: ${item.detail}`);
  }
}

function errorMessage(err) {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

function truncate(value) {
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}

function env(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function printHelp() {
  console.log(`Usage: node scripts/check-hosted-daemon-tls-entra.mjs [--skip-auth] [--skip-azure] [--json]

Checks the hosted daemon TLS + Entra acceptance gates:
  - HTTPS /health is reachable and returns status=ok.
  - HTTPS /pods/stats accepts an Entra token from AUTOPOD_DAEMON_TOKEN or ap token.
  - Direct public :3100 is not reachable from this client.
  - The Entra app registration has the native desktop redirect URI.
  - The current Azure identity can read the sandbox resource group.

Environment overrides:
  HOSTED_DAEMON_URL              default ${DEFAULT_DAEMON_URL}
  HOSTED_DAEMON_DIRECT_URL       default ${DEFAULT_DIRECT_URL}
  AUTOPOD_DAEMON_TOKEN           token for authenticated-stats
  ENTRA_CLIENT_ID                default ${DEFAULT_APP_ID}
  ENTRA_DESKTOP_REDIRECT_URI     default ${DEFAULT_REDIRECT_URI}
  AZURE_SUBSCRIPTION_ID          default ${DEFAULT_SUBSCRIPTION_ID}
  AZURE_RESOURCE_GROUP           default ${DEFAULT_RESOURCE_GROUP}
  HOSTED_DAEMON_CHECK_TIMEOUT_MS default 12000
`);
}

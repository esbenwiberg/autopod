#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const daemonRequire = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
const pino = daemonRequire('pino');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage:
  SANDBOX_IMAGE=<acr-image> AZURE_SUBSCRIPTION_ID=<sub> AZURE_RESOURCE_GROUP=<rg> \\
    node scripts/prove-sandbox-preview-tunnel.mjs

Required env:
  AZURE_SUBSCRIPTION_ID
  AZURE_RESOURCE_GROUP
  SANDBOX_IMAGE                         ACR-qualified warm image to run

Optional env:
  AZURE_SANDBOX_LOCATION                Default: AZURE_LOCATION or swedencentral
  AZURE_SANDBOX_GROUP                   Default: SANDBOX_GROUP or autopod-spike
  AZURE_SANDBOX_TIER                    Default: SANDBOX_TIER or L
  AZURE_SANDBOX_ASSUME_GROUP_EXISTS=1
  AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID
  AZURE_SANDBOX_REGISTRY_USERNAME
  AZURE_SANDBOX_REGISTRY_TOKEN
  SANDBOX_TUNNEL_NETWORK=restricted     Default: allow-all
  SANDBOX_TUNNEL_ALLOWED_HOSTS=a,b      Only used with restricted mode
  SANDBOX_TUNNEL_KEEP=1                 Do not destroy the sandbox on success
  SANDBOX_TUNNEL_KEEP_ON_FAIL=1         Keep the sandbox when proof fails
  SANDBOX_TUNNEL_TIMEOUT_MS=120000
  SANDBOX_TUNNEL_CLOUDFLARED_URL=<url>  Override cloudflared binary download
`);
  process.exit(0);
}

const subscriptionId = requiredEnv('AZURE_SUBSCRIPTION_ID');
const resourceGroup = requiredEnv('AZURE_RESOURCE_GROUP');
const location =
  process.env.AZURE_SANDBOX_LOCATION ?? process.env.AZURE_LOCATION ?? 'swedencentral';
const sandboxGroup =
  process.env.AZURE_SANDBOX_GROUP ?? process.env.SANDBOX_GROUP ?? 'autopod-spike';
const tier = process.env.AZURE_SANDBOX_TIER ?? process.env.SANDBOX_TIER ?? 'L';
const image = requiredEnv('SANDBOX_IMAGE');
const imagePullIdentityResourceId =
  process.env.AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID ??
  process.env.SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID;
const registryCredentials = sandboxRegistryCredentials();
const networkMode = process.env.SANDBOX_TUNNEL_NETWORK ?? 'allow-all';
const allowedHosts =
  process.env.SANDBOX_TUNNEL_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean) ?? defaultTunnelAllowedHosts();
const keep = process.env.SANDBOX_TUNNEL_KEEP === '1';
const keepOnFail = process.env.SANDBOX_TUNNEL_KEEP_ON_FAIL === '1';
const timeoutMs = positiveIntegerEnv('SANDBOX_TUNNEL_TIMEOUT_MS', 120_000);
const cloudflaredUrl =
  process.env.SANDBOX_TUNNEL_CLOUDFLARED_URL ??
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
const proofToken = randomUUID();
const podId = `sandbox-preview-${Date.now().toString(36)}`;

if (networkMode !== 'allow-all' && networkMode !== 'restricted') {
  throw new Error('SANDBOX_TUNNEL_NETWORK must be "allow-all" or "restricted"');
}

const distDir = resolve(rootDir, 'packages/daemon/dist');
const entry = readdirSync(distDir).find(
  (file) => file.startsWith('sandbox-container-manager-') && file.endsWith('.js'),
);
if (!entry) {
  throw new Error('Run `npx pnpm --filter @autopod/daemon build` before this proof.');
}

const { SandboxContainerManager } = await import(pathToFileURL(resolve(distDir, entry)).href);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const manager = SandboxContainerManager.withAzureClient(
  {
    subscriptionId,
    resourceGroup,
    location,
    sandboxGroup,
    tier,
    assumeGroupExists:
      process.env.AZURE_SANDBOX_ASSUME_GROUP_EXISTS === '1' ||
      process.env.SANDBOX_ASSUME_GROUP_EXISTS === '1',
    imagePullIdentityResourceId,
    registryCredentials,
  },
  logger,
);

let sandboxId;
let passed = false;

try {
  console.log(`spawning sandbox with image=${image}`);
  sandboxId = await manager.spawn({
    image,
    podId,
    env: {
      POD_ID: podId,
      AUTOPOD_TUNNEL_PROOF_TOKEN: proofToken,
    },
    networkPolicyMode: networkMode,
    allowedHosts: networkMode === 'restricted' ? allowedHosts : undefined,
  });
  console.log(`sandbox=${sandboxId}`);
  console.log(
    `egress=${networkMode}${networkMode === 'restricted' ? ` ${allowedHosts.join(',')}` : ''}`,
  );

  await manager.writeFile(sandboxId, '/tmp/autopod-preview-proof-app.js', proofAppSource());
  await manager.writeFile(sandboxId, '/tmp/autopod-preview-proof-start.sh', proofStartScript());

  const start = await manager.execInContainer(
    sandboxId,
    ['sh', '/tmp/autopod-preview-proof-start.sh'],
    {
      timeout: timeoutMs,
      env: {
        AUTOPOD_TUNNEL_PROOF_TOKEN: proofToken,
        AUTOPOD_TUNNEL_PROOF_CLOUDFLARED_URL: cloudflaredUrl,
      },
    },
  );
  console.log(`start=${JSON.stringify(start)}`);
  if (start.exitCode !== 0) {
    throw new Error(`proof startup failed with exit code ${start.exitCode}`);
  }

  const publicUrl = await waitForTryCloudflareUrl(manager, sandboxId, timeoutMs);
  console.log(`public_url=${publicUrl}`);

  const body = await waitForPublicProof(publicUrl, proofToken, timeoutMs);
  console.log(`public_response=${JSON.stringify(body.slice(0, 200))}`);

  passed = true;
  console.log('proof=pass');
} catch (err) {
  console.error(`proof=fail ${err instanceof Error ? err.message : String(err)}`);
  if (sandboxId) {
    await dumpSandboxLogs(manager, sandboxId).catch((logErr) => {
      console.error(`log_dump_failed=${logErr instanceof Error ? logErr.message : String(logErr)}`);
    });
  }
  process.exitCode = 1;
} finally {
  if (sandboxId && !(keep || (!passed && keepOnFail))) {
    await manager.kill(sandboxId);
    console.log(`destroyed=${sandboxId}`);
  } else if (sandboxId) {
    console.log(`kept=${sandboxId}`);
  }
}

function proofAppSource() {
  return `const http = require('node:http');
const token = process.env.AUTOPOD_TUNNEL_PROOF_TOKEN || 'missing-token';
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok ' + token + '\\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('autopod sandbox tunnel proof ' + token + '\\npath=' + req.url + '\\n');
});
server.listen(3000, '127.0.0.1', () => {
  console.log('LISTENING ' + token);
});
`;
}

function proofStartScript() {
  return `#!/bin/sh
set -eu

: "\${AUTOPOD_TUNNEL_PROOF_TOKEN:?missing proof token}"
: "\${AUTOPOD_TUNNEL_PROOF_CLOUDFLARED_URL:?missing cloudflared url}"

rm -f /tmp/autopod-proof-app.log /tmp/autopod-cloudflared.log

command -v node >/dev/null 2>&1 || { echo "node is required"; exit 127; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 127; }

curl -fsSL "\${AUTOPOD_TUNNEL_PROOF_CLOUDFLARED_URL}" -o /tmp/autopod-cloudflared
chmod +x /tmp/autopod-cloudflared

AUTOPOD_TUNNEL_PROOF_TOKEN="\${AUTOPOD_TUNNEL_PROOF_TOKEN}" \\
  nohup node /tmp/autopod-preview-proof-app.js > /tmp/autopod-proof-app.log 2>&1 &
echo "$!" > /tmp/autopod-proof-app.pid

i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:3000/health >/tmp/autopod-proof-health.txt 2>/tmp/autopod-proof-health.err; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 30 ]; then
  echo "local app did not become healthy"
  cat /tmp/autopod-proof-app.log 2>/dev/null || true
  cat /tmp/autopod-proof-health.err 2>/dev/null || true
  exit 1
fi

nohup /tmp/autopod-cloudflared tunnel \\
  --url http://127.0.0.1:3000 \\
  --no-autoupdate \\
  > /tmp/autopod-cloudflared.log 2>&1 &
echo "$!" > /tmp/autopod-cloudflared.pid

sleep 2
echo "started app_pid=$(cat /tmp/autopod-proof-app.pid) cloudflared_pid=$(cat /tmp/autopod-cloudflared.pid)"
`;
}

async function waitForTryCloudflareUrl(containerManager, containerId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastLog = '';
  while (Date.now() < deadline) {
    lastLog = await safeRead(containerManager, containerId, '/tmp/autopod-cloudflared.log');
    const match = lastLog.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com\b/i);
    if (match) return match[0];
    await sleep(2_000);
  }
  throw new Error(`cloudflared did not publish a trycloudflare URL. Last log:\n${lastLog}`);
}

async function waitForPublicProof(publicUrl, token, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${publicUrl}/?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(12_000),
      });
      const text = await response.text();
      if (response.ok && text.includes(token)) return text;
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(2_000);
  }
  throw new Error(`public tunnel did not serve proof token. Last error: ${lastError}`);
}

async function dumpSandboxLogs(containerManager, containerId) {
  const [appLog, cloudflaredLog, healthErr] = await Promise.all([
    safeRead(containerManager, containerId, '/tmp/autopod-proof-app.log'),
    safeRead(containerManager, containerId, '/tmp/autopod-cloudflared.log'),
    safeRead(containerManager, containerId, '/tmp/autopod-proof-health.err'),
  ]);
  console.error(`app_log=${JSON.stringify(appLog.slice(-2000))}`);
  console.error(`cloudflared_log=${JSON.stringify(cloudflaredLog.slice(-4000))}`);
  console.error(`health_err=${JSON.stringify(healthErr.slice(-1000))}`);
}

async function safeRead(containerManager, containerId, path) {
  try {
    return await containerManager.readFile(containerId, path);
  } catch {
    return '';
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function sandboxRegistryCredentials() {
  const username =
    process.env.AZURE_SANDBOX_REGISTRY_USERNAME ?? process.env.SANDBOX_REGISTRY_USERNAME;
  const token = process.env.AZURE_SANDBOX_REGISTRY_TOKEN ?? process.env.SANDBOX_REGISTRY_TOKEN;
  if (!username && !token) return undefined;
  if (!username || !token) {
    throw new Error(
      'Both AZURE_SANDBOX_REGISTRY_USERNAME and AZURE_SANDBOX_REGISTRY_TOKEN must be set when using sandbox registry credentials.',
    );
  }
  return { username, token };
}

function defaultTunnelAllowedHosts() {
  return [
    'github.com',
    '*.github.com',
    '*.githubusercontent.com',
    '*.githubassets.com',
    'cloudflare.com',
    '*.cloudflare.com',
    'argotunnel.com',
    '*.argotunnel.com',
    '*.trycloudflare.com',
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

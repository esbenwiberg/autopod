#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const daemonRequire = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
const pino = daemonRequire('pino');

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
const allowedHost = process.env.SANDBOX_ALLOWED_HOST ?? 'api.github.com';
const refreshHost = process.env.SANDBOX_REFRESH_HOST ?? 'example.com';

const distDir = resolve(rootDir, 'packages/daemon/dist');
const entry = readdirSync(distDir).find(
  (file) => file.startsWith('sandbox-container-manager-') && file.endsWith('.js'),
);
if (!entry) {
  throw new Error('Run `npx pnpm --filter @autopod/daemon build` before this smoke test.');
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
const workspaceDir = mkdtempSync(join(tmpdir(), 'autopod-sandbox-smoke-'));
try {
  writeFileSync(join(workspaceDir, 'input.txt'), 'from-host\n');
  sandboxId = await manager.spawn({
    image,
    podId: 'sandbox-smoke',
    env: { POD_ID: 'sandbox-smoke' },
    networkPolicyMode: 'restricted',
    allowedHosts: [allowedHost],
    volumes: [{ host: workspaceDir, container: '/mnt/worktree' }],
  });
  console.log(`sandbox=${sandboxId}`);

  const exec = await manager.execInContainer(sandboxId, ['sh', '-lc', 'echo TS-SMOKE']);
  console.log(`exec=${JSON.stringify(exec)}`);
  if (exec.exitCode !== 0 || !exec.stdout.includes('TS-SMOKE')) {
    throw new Error('exec smoke failed');
  }

  if (!manager.supportsStreamingExec) {
    throw new Error('streaming exec smoke failed: manager reports supportsStreamingExec=false');
  }
  const streamed = await manager.execStreaming(sandboxId, [
    'sh',
    '-lc',
    'for i in 1 2 3; do echo chunk-$i; sleep 1; done; echo TS-STREAM-DONE; exit 7',
  ]);
  const arrivals = [];
  let streamedOut = '';
  let streamedErr = '';
  streamed.stdout.on('data', (chunk) => {
    streamedOut += String(chunk);
    arrivals.push(Date.now());
  });
  streamed.stderr.on('data', (chunk) => {
    streamedErr += String(chunk);
  });
  const streamExit = await streamed.exitCode;
  const spreadMs = arrivals.length > 1 ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
  console.log(
    `exec_stream=${JSON.stringify({ exitCode: streamExit, chunks: arrivals.length, spreadMs, stdout: streamedOut, stderr: streamedErr })}`,
  );
  if (streamExit !== 7 || !streamedOut.includes('TS-STREAM-DONE')) {
    throw new Error('streaming exec smoke failed');
  }
  if (spreadMs < 1000) {
    // Three 1s-spaced echoes should arrive over ~2s of wall clock. A single
    // burst means the transport buffered — still functional, but flag it.
    console.warn('exec_stream_warning=chunks arrived in one burst; transport may be buffering');
  }

  await manager.writeFile(sandboxId, '/tmp/autopod-smoke.txt', 'hello from ts');
  const file = await manager.readFile(sandboxId, '/tmp/autopod-smoke.txt');
  console.log(`file=${file}`);
  if (file !== 'hello from ts') {
    throw new Error('file smoke failed');
  }

  const workspace = await manager.execInContainer(sandboxId, [
    'sh',
    '-lc',
    [
      'rm -rf /workspace/autopod-smoke-workspace',
      'mkdir -p /workspace/autopod-smoke-workspace',
      'cp -a /mnt/worktree/. /workspace/autopod-smoke-workspace/',
      'printf "from-sandbox\\n" > /workspace/autopod-smoke-workspace/output.txt',
      'cat /workspace/autopod-smoke-workspace/input.txt',
    ].join(' && '),
  ]);
  console.log(`workspace_exec=${JSON.stringify(workspace)}`);
  if (workspace.exitCode !== 0 || !workspace.stdout.includes('from-host')) {
    throw new Error('workspace smoke failed');
  }
  await manager.extractDirectoryFromContainer(
    sandboxId,
    '/workspace/autopod-smoke-workspace',
    workspaceDir,
    ['node_modules'],
  );
  const output = readFileSync(join(workspaceDir, 'output.txt'), 'utf-8');
  console.log(`workspace_sync_back=${JSON.stringify(output)}`);
  if (output !== 'from-sandbox\n') {
    throw new Error('workspace sync-back smoke failed');
  }

  await manager.refreshFirewall(
    sandboxId,
    JSON.stringify({
      sandboxEgressPolicy: {
        defaultAction: 'Deny',
        hostRules: [
          { pattern: allowedHost, action: 'Allow' },
          { pattern: refreshHost, action: 'Allow' },
        ],
      },
    }),
  );
  console.log('egress_refresh=ok');
} finally {
  if (sandboxId) {
    await manager.kill(sandboxId);
    console.log(`destroyed=${sandboxId}`);
  }
  rmSync(workspaceDir, { recursive: true, force: true });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
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

#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
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
const image = process.env.SANDBOX_IMAGE ?? 'mcr.microsoft.com/cbl-mariner/base/core:2.0';
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
  },
  logger,
);

let sandboxId;
try {
  sandboxId = await manager.spawn({
    image,
    podId: 'sandbox-smoke',
    env: { POD_ID: 'sandbox-smoke' },
    networkPolicyMode: 'restricted',
    allowedHosts: [allowedHost],
  });
  console.log(`sandbox=${sandboxId}`);

  const exec = await manager.execInContainer(sandboxId, ['sh', '-lc', 'echo TS-SMOKE']);
  console.log(`exec=${JSON.stringify(exec)}`);
  if (exec.exitCode !== 0 || !exec.stdout.includes('TS-SMOKE')) {
    throw new Error('exec smoke failed');
  }

  await manager.writeFile(sandboxId, '/tmp/autopod-smoke.txt', 'hello from ts');
  const file = await manager.readFile(sandboxId, '/tmp/autopod-smoke.txt');
  console.log(`file=${file}`);
  if (file !== 'hello from ts') {
    throw new Error('file smoke failed');
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
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

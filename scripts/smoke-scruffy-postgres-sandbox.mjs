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
const image = requiredEnv('SANDBOX_IMAGE');
const imagePullIdentityResourceId =
  process.env.AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID ??
  process.env.SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID;
const registryCredentials = sandboxRegistryCredentials();

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

const resetAndProvision = [
  'if [ -s "$PGDATA/PG_VERSION" ] && pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then',
  '  pg_ctl -D "$PGDATA" -m fast -w stop',
  'fi',
  'rm -rf -- "$PGDATA"',
  'initdb -D "$PGDATA" -U postgres --auth=trust',
  'pg_ctl -D "$PGDATA" -o "-h 127.0.0.1 -p 5433" -l "$PGDATA/postgres.log" -w start',
  'createuser -h 127.0.0.1 -p 5433 -U postgres --login scruffy',
  'createdb -h 127.0.0.1 -p 5433 -U postgres -O scruffy scruffy',
].join('\n');

let sandboxId;
try {
  sandboxId = await manager.spawn({
    image,
    podId: 'scruffy-postgres-smoke',
    env: { POD_ID: 'scruffy-postgres-smoke' },
    networkPolicyMode: 'deny-all',
    allowedHosts: [],
    volumes: [],
  });
  console.log(`sandbox=${sandboxId}`);

  await run('fresh PostgreSQL startup', [
    'test ! -e /var/run/postgresql',
    'test "$PGDATA" = /tmp/pgdata',
    'test "$PGHOST" = 127.0.0.1',
    'test "$PGPORT" = 5433',
    'rm -rf -- "$PGDATA"',
    'initdb -D "$PGDATA" -U postgres --auth=trust',
    'grep -Fx "unix_socket_directories = \'\'" "$PGDATA/postgresql.conf"',
    'pg_ctl -D "$PGDATA" -o "-h 127.0.0.1 -p 5433" -l "$PGDATA/postgres.log" -w start',
    'pg_isready -h 127.0.0.1 -p 5433 -U postgres -d postgres',
  ]);

  await run('agent-like dirty state', [
    'pg_ctl -D "$PGDATA" -m fast -w stop',
    'rm -rf -- "$PGDATA"',
    'initdb -D "$PGDATA" -U scruffy --auth=trust',
    'pg_ctl -D "$PGDATA" -o "-h 127.0.0.1 -p 5433" -l "$PGDATA/postgres.log" -w start',
    'psql -h 127.0.0.1 -p 5433 -U scruffy -d postgres -v ON_ERROR_STOP=1 -tAc "SELECT current_user" | grep -Fx scruffy',
    'test "$(psql -h 127.0.0.1 -p 5433 -U scruffy -d postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname = \'autopod\'")" = 0',
  ]);

  await run('validation reset and provisioning', [resetAndProvision]);
  await run('repeatable validation reset and provisioning', [resetAndProvision]);
  await run('final Scruffy database assertions', [
    'test "$(psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -tAc "SELECT current_user")" = postgres',
    'test "$(psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -tAc "SELECT rolcanlogin FROM pg_roles WHERE rolname = \'scruffy\'")" = t',
    'test "$(psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = \'scruffy\'")" = scruffy',
    'test "$(psql "postgresql://scruffy@127.0.0.1:5433/scruffy" -v ON_ERROR_STOP=1 -tAc "SELECT 42")" = 42',
  ]);
  console.log('scruffy_postgres_smoke=ok');
} finally {
  if (sandboxId) {
    await manager.kill(sandboxId);
    console.log(`destroyed=${sandboxId}`);
  }
}

async function run(label, commands) {
  const result = await manager.execInContainer(sandboxId, ['sh', '-euc', commands.join('\n')]);
  console.log(`${label}=${JSON.stringify(result)}`);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed`);
  }
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

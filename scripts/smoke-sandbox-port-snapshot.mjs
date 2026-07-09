#!/usr/bin/env node
import { readdirSync } from 'node:fs';
// Ad-hoc smoke for #188 (native port exposure) + #190 (snapshot warm-start).
// Mirrors scripts/smoke-sandbox-adapter.mjs construction. Requires the same env.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const daemonRequire = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
const pino = daemonRequire('pino');

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const subscriptionId = requiredEnv('AZURE_SUBSCRIPTION_ID');
const resourceGroup = requiredEnv('AZURE_RESOURCE_GROUP');
const location = process.env.AZURE_SANDBOX_LOCATION ?? 'swedencentral';
const sandboxGroup = process.env.AZURE_SANDBOX_GROUP ?? 'autopod-spike';
const tier = process.env.AZURE_SANDBOX_TIER ?? 'L';
const image = requiredEnv('SANDBOX_IMAGE');
const imagePullIdentityResourceId = process.env.AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID;
const entraEmail = process.env.SANDBOX_PREVIEW_EMAIL ?? 'd-ewi@contextand.com';

const distDir = resolve(rootDir, 'packages/daemon/dist');
const entry = readdirSync(distDir).find(
  (f) => f.startsWith('sandbox-container-manager-') && f.endsWith('.js'),
);
if (!entry) throw new Error('Run `npx pnpm --filter @autopod/daemon build` first.');
const { SandboxContainerManager } = await import(pathToFileURL(resolve(distDir, entry)).href);

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const manager = SandboxContainerManager.withAzureClient(
  {
    subscriptionId,
    resourceGroup,
    location,
    sandboxGroup,
    tier,
    assumeGroupExists: process.env.AZURE_SANDBOX_ASSUME_GROUP_EXISTS === '1',
    imagePullIdentityResourceId,
  },
  logger,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function probeStatus(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return res.status;
  } catch (err) {
    return `ERR:${String(err).slice(0, 60)}`;
  }
}

let sandboxA;
let sandboxB;
let snapshotId;
const results = {};
try {
  // ── Spawn A ──────────────────────────────────────────────────────
  sandboxA = await manager.spawn({
    image,
    podId: 'port-snap-smoke',
    env: { POD_ID: 'port-snap-smoke' },
    networkPolicyMode: 'allow-all',
  });
  console.log(`sandboxA=${sandboxA}`);

  // ── #188 Native port exposure ────────────────────────────────────
  const exposed = await manager.exposePort(sandboxA, 3000, { entraEmails: [entraEmail] });
  results.port_url = exposed.url;
  console.log(`exposed=${JSON.stringify(exposed)}`);
  const urlOk = /--3000\..*\.adcproxy\.io/.test(exposed.url ?? '');
  results.port_url_shape = urlOk ? 'ok' : 'BAD';

  // Entra-gated: an unauthenticated request must be blocked (401), not leaked.
  let unauth = await probeStatus(exposed.url);
  for (let i = 0; i < 6 && unauth !== 401; i++) {
    await sleep(3000);
    unauth = await probeStatus(exposed.url);
  }
  results.unauth_status = unauth;

  // Remove → URL should stop resolving (404).
  await manager.unexposePort(sandboxA, 3000);
  let afterRemove = await probeStatus(exposed.url);
  for (let i = 0; i < 6 && afterRemove !== 404; i++) {
    await sleep(3000);
    afterRemove = await probeStatus(exposed.url);
  }
  results.after_remove_status = afterRemove;

  // ── #190 Snapshot warm-start ─────────────────────────────────────
  const marker = `snap-marker-${sandboxA}`;
  await manager.writeFile(sandboxA, '/workspace/marker.txt', marker);
  const client = manager.client; // private at TS level; plain property at runtime
  const snap = await client.createSnapshot(sandboxA, 'autopod-smoke-snap');
  snapshotId = snap.id;
  console.log(`snapshot=${snapshotId}`);

  sandboxB = await client.createFromSnapshot(snapshotId);
  console.log(`sandboxB=${sandboxB}`);
  const carried = await manager.readFile(sandboxB, '/workspace/marker.txt');
  results.snapshot_marker_carried = carried.trim() === marker ? 'ok' : `BAD(${carried})`;

  await client.deleteSnapshot(snapshotId);
  snapshotId = null;
  results.snapshot_deleted = 'ok';

  console.log(`RESULTS=${JSON.stringify(results)}`);
  const pass =
    results.port_url_shape === 'ok' &&
    results.unauth_status === 401 &&
    results.after_remove_status === 404 &&
    results.snapshot_marker_carried === 'ok' &&
    results.snapshot_deleted === 'ok';
  console.log(pass ? 'SMOKE_PASS' : 'SMOKE_FAIL');
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.error('SMOKE_ERROR', err);
  console.log(`RESULTS=${JSON.stringify(results)}`);
  process.exitCode = 1;
} finally {
  const client = manager.client;
  if (snapshotId) await client.deleteSnapshot(snapshotId).catch(() => {});
  if (sandboxB) await manager.kill(sandboxB).catch(() => {});
  if (sandboxA) await manager.kill(sandboxA).catch(() => {});
  console.log('cleaned-up');
}

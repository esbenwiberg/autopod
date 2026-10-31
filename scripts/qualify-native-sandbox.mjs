#!/usr/bin/env node
// Opt-in only: node scripts/qualify-native-sandbox.mjs --live /private/selected-target.json
// Local control proof: node --test scripts/qualify-native-sandbox.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  API_VERSION,
  MAX_BYTES,
  createGuard,
  endpoints,
  listItems,
  sha256,
  supervise,
  validateTarget,
  verifyCache,
  verifyOwner,
} from './lib/native-sandbox-qualification.mjs';

const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), '..');
const daemonRequire = createRequire(join(root, 'packages/daemon/package.json'));
const WORK_MS = 10 * 60_000;
const CLEANUP_MS = 6 * 60_000;
const log = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
};
const json = (path) => {
  const bytes = readFileSync(path);
  assert(bytes.length <= MAX_BYTES, 'oversized-local-input');
  return JSON.parse(bytes);
};
const saveJson = (path, object) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(object, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
const azure = (args) =>
  JSON.parse(
    execFileSync('az', [...args, '-o', 'json'], {
      timeout: 15_000,
      maxBuffer: MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

export async function buildAdapter(directory) {
  const { build } = await import('esbuild');
  const outfile = join(directory, 'adapter.cjs');
  const result = await build({
    stdin: {
      contents: [
        "export { AzureSandboxApiClient } from './packages/daemon/src/containers/azure-sandbox-api-client.ts';",
        "export { SandboxContainerManager } from './packages/daemon/src/containers/sandbox-container-manager.ts';",
        "export { createSandboxWakeupJournal } from './packages/daemon/src/containers/sandbox-wakeup-journal.ts';",
        "export { default as wakeupSchema } from './packages/daemon/src/db/migrations/218_sandbox_wakeup_intents.sql';",
        "export { default as wakeupEvidenceSchema } from './packages/daemon/src/db/migrations/222_sandbox_wakeup_evidence.sql';",
      ].join('\n'),
      resolveDir: root,
    },
    outfile,
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['@azure/identity', 'tar-stream', 'better-sqlite3'],
    loader: { '.sql': 'text' },
    alias: { '@autopod/shared': join(root, 'packages/shared/src/index.ts') },
    metafile: true,
    logLevel: 'silent',
  });
  return {
    outfile,
    bundleSha256: sha256(readFileSync(outfile)),
    inputs: Object.fromEntries(
      Object.keys(result.metafile.inputs)
        .filter((path) => path !== '<stdin>')
        .map((path) => [path, sha256(readFileSync(resolve(root, path)))]),
    ),
  };
}

export function openWakeupJournal(bundle, filename) {
  const { createSandboxWakeupJournal, wakeupSchema, wakeupEvidenceSchema } = daemonRequire(bundle);
  const Database = daemonRequire('better-sqlite3');
  const db = new Database(filename);
  chmodSync(filename, 0o600);
  db.pragma('foreign_keys = ON');
  const initialized = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sandbox_wakeup_baselines'")
    .get();
  db.transaction(() => {
    if (!initialized) db.exec(wakeupSchema);
    const hasEvidence = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sandbox_wakeup_evidence'")
      .get();
    if (!hasEvidence) db.exec(wakeupEvidenceSchema);
  })();
  return {
    journal: createSandboxWakeupJournal(db),
    close: () => {
      if (db.open) db.close();
    },
  };
}

async function connection(receipt, receiptPath, bundle, cleanup) {
  const target = validateTarget(receipt.target);
  const { AzureSandboxApiClient, SandboxContainerManager } = daemonRequire(bundle);
  const { AzureCliCredential } = daemonRequire('@azure/identity');
  const cliCredential = new AzureCliCredential({
    subscription: target.subscriptionId,
    processTimeoutInMs: 15_000,
  });
  const credential = {
    getToken(scope) {
      assert.equal(scope, 'https://dynamicsessions.io/.default', 'unexpected-token-scope');
      return cliCredential.getToken(scope);
    },
  };
  const save = () => saveJson(receiptPath, receipt);
  // Keep this beside the durable receipt, not inside the disposable source bundle.
  const wakeup = openWakeupJournal(bundle, `${receiptPath}.wakeups.sqlite`);
  const guard = createGuard({ target, receipt, save, cleanup });
  const client = new AzureSandboxApiClient(
    {
      ...target,
      credential,
      wakeupJournal: wakeup.journal,
      assumeGroupExists: true,
      fetch: guard.fetch,
      webSocket: guard.webSocket,
      retry: { maxAttempts: 1 },
    },
    log,
  );
  const manager = new SandboxContainerManager(client, log, { defaultTier: 'S' });
  const { base } = endpoints(target);
  const get = async (path) => {
    const token = await credential.getToken('https://dynamicsessions.io/.default');
    const response = await guard.fetch(`${base}${path}?api-version=${API_VERSION}`, {
      headers: { Authorization: `Bearer ${token.token}` },
    });
    assert([200, 404].includes(response.status), 'unexpected-get-status');
    const body = response.status === 200 ? await response.json() : null;
    if (
      body?.state === 'Running' &&
      typeof body.id === 'string' &&
      path === `/sandboxes/${body.id}`
    )
      wakeup.journal.observeRunning(`${base}${path}`.toLowerCase(), body.id);
    return { status: response.status, body };
  };
  return { client, manager, guard, get, save, close: wakeup.close };
}

async function preflight(receipt, get, save) {
  const target = receipt.target;
  const account = azure(['account', 'show', '--query', '{id:id,state:state}']);
  assert.equal(account.id, target.subscriptionId);
  assert.equal(account.state, 'Enabled');
  const groupId = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/sandboxGroups/${target.sandboxGroup}`;
  const group = azure([
    'resource',
    'show',
    '--ids',
    groupId,
    '--api-version',
    API_VERSION,
    '--query',
    '{id:id,location:location,state:properties.provisioningState,identity:identity}',
  ]);
  assert.equal(group.id.toLowerCase(), groupId.toLowerCase());
  assert.equal(group.location, target.location);
  assert.equal(group.state, 'Succeeded');
  assert(
    Object.keys(group.identity?.userAssignedIdentities ?? {}).some(
      (id) => id.toLowerCase() === target.imagePullIdentityResourceId.toLowerCase(),
    ),
  );
  const diskImages = await get('/diskimages');
  assert.equal(diskImages.status, 200);
  verifyCache(target, listItems(diskImages.body));
  const sandboxes = await get('/sandboxes');
  assert.equal(sandboxes.status, 200);
  const initial = listItems(sandboxes.body);
  assert(initial.every((item) => typeof item.id === 'string' && item.id.length > 0));
  assert(!initial.some((item) => item.labels?.podId === receipt.runId));
  receipt.initialIds = initial.map((item) => item.id);
  receipt.preflightPassed = true;
  save();
}

async function boundaries(receipt, { manager, client, guard, get, save }) {
  const workspace = join(receipt.workspace, 'input');
  const output = join(receipt.workspace, 'output');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'from-host\n');
  const id = await manager.spawn({
    image: receipt.target.image,
    podId: receipt.runId,
    env: {},
    networkPolicyMode: 'deny-all',
    volumes: [{ host: workspace, container: '/mnt/worktree' }],
    onCreated(createdId) {
      assert.equal(createdId, receipt.acceptedId);
    },
  });
  assert.equal(id, receipt.acceptedId);
  const full = await get(`/sandboxes/${id}`);
  verifyOwner(full.body, receipt.runId, receipt.initialIds);
  assert.equal(full.body.sourcesRef?.diskImage?.id, receipt.target.readyDiskImageId);
  assert.equal(await client.getImageDigest(id), receipt.target.image.split('@')[1]);
  assert.deepEqual(await client.getResourceAllocation(id), {
    memoryLimitBytes: 2 ** 30,
    cpuLimit: 0.5,
  });
  receipt.boundaries = { spawn: true, image: true, allocation: true };
  save();
  const buffered = await manager.execInContainer(id, ['sh', '-c', 'printf BUFFERED; exit 7'], {
    timeout: 20_000,
  });
  assert.deepEqual(buffered, { stdout: 'BUFFERED', stderr: '', exitCode: 7 });
  receipt.boundaries.buffered = true;
  save();
  const stream = await manager.execStreaming(
    id,
    [
      'sh',
      '-c',
      'printf "FIRST\\n"; sleep 1; printf "SECOND\\n"; sleep 1; printf "THIRD\\n"; printf "ERR\\n" >&2; exit 7',
    ],
    { timeout: 20_000 },
  );
  const arrivals = [];
  let stdout = '';
  let stderr = '';
  stream.stdout.on('data', (chunk) => {
    stdout += chunk;
    arrivals.push(Date.now());
  });
  stream.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // No remote error text is printed or persisted.
  stream.stdout.on('error', () => {});
  stream.stderr.on('error', () => {});
  const [streamExit] = await Promise.all([
    stream.exitCode,
    finished(stream.stdout),
    finished(stream.stderr),
  ]);
  assert.equal(streamExit, 7);
  assert.equal(stdout, 'FIRST\nSECOND\nTHIRD\n');
  assert.equal(stderr, 'ERR\n');
  const spreadMs = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
  assert(spreadMs >= 1000, 'stream-was-buffered');
  receipt.boundaries.stream = { chunks: arrivals.length, spreadMs };
  save();
  const path = `/tmp/${receipt.runId}.txt`;
  await manager.writeFile(id, path, 'exact synthetic bytes\n');
  assert.equal(await manager.readFile(id, path), 'exact synthetic bytes\n');
  const remote = `/workspace/${receipt.runId}`;
  const copy = await manager.execInContainer(
    id,
    [
      'sh',
      '-c',
      `mkdir -p ${remote} && cp /mnt/worktree/input.txt ${remote}/input.txt && printf 'from-sandbox\\n' > ${remote}/output.txt`,
    ],
    { timeout: 20_000 },
  );
  assert.equal(copy.exitCode, 0);
  await manager.extractDirectoryFromContainer(id, remote, output, ['node_modules']);
  assert.equal(readFileSync(join(output, 'input.txt'), 'utf8'), 'from-host\n');
  assert.equal(readFileSync(join(output, 'output.txt'), 'utf8'), 'from-sandbox\n');
  receipt.boundaries.files = true;
  receipt.boundaries.workspace = true;
  save();
  await manager.refreshFirewall(
    id,
    JSON.stringify({ sandboxEgressPolicy: { defaultAction: 'Deny', hostRules: [] } }),
  );
  const policy = (await get(`/sandboxes/${id}`)).body.egressPolicy;
  assert.equal(policy.defaultAction, 'Deny');
  assert.equal((policy.hostRules ?? []).length, 0);
  assert.equal((policy.rules ?? []).length, 0);
  receipt.boundaries.egress = true;
  save();
  await manager.kill(id);
  assert.equal((await get(`/sandboxes/${id}`)).status, 404);
  await manager.kill(id);
  assert.equal((await get(`/sandboxes/${id}`)).status, 404);
  receipt.boundaries.kill = true;
  receipt.normalDeletion404 = true;
  save();
  assert.equal(receipt.guardFailures?.length ?? 0, 0);
  guard.close();
}

export async function cleanupOwned(
  receipt,
  { manager, guard, get, save },
  discoveryMs = 5 * 60_000,
) {
  if (!receipt.createAttempted) {
    receipt.cleanup = { noCreateAttempted: true };
    save();
    return;
  }
  const deadline = Date.now() + discoveryMs;
  while (!receipt.acceptedId && Date.now() < deadline) {
    const listed = await get('/sandboxes');
    assert.equal(listed.status, 200);
    const matches = listItems(listed.body).filter((item) => item.labels?.podId === receipt.runId);
    assert(matches.length <= 1, 'ambiguous-owned-discovery');
    if (matches.length) {
      const observed = await get(`/sandboxes/${matches[0].id}`);
      assert.equal(observed.status, 200);
      assert.equal(observed.body.id, matches[0].id);
      guard.adopt(observed.body);
    } else await delay(Math.min(3000, Math.max(1, deadline - Date.now())));
  }
  assert(receipt.acceptedId, 'unresolved-create-outcome');
  const path = `/sandboxes/${receipt.acceptedId}`;
  const observed = await get(path);
  if (observed.status === 200) {
    guard.adopt(observed.body);
    await manager.kill(receipt.acceptedId);
  }
  assert.equal((await get(path)).status, 404);
  receipt.cleanup = { id: receipt.acceptedId, deletion404: true };
  save();
  const remaining = await get('/sandboxes');
  assert.equal(remaining.status, 200);
  const ids = listItems(remaining.body).map((item) => item.id);
  assert(
    receipt.initialIds.every((id) => ids.includes(id)),
    'unrelated-resource-no-longer-present',
  );
  verifyCache(receipt.target, listItems((await get('/diskimages')).body));
  receipt.cleanup.unrelatedAndCachePreserved = true;
  save();
}

async function child(mode, receiptPath, bundle) {
  const receipt = json(receiptPath);
  assert.match(receipt.runId, /^r01c-[a-f0-9-]{36}$/);
  const ctx = await connection(receipt, receiptPath, bundle, mode === '--cleanup');
  try {
    if (mode === '--work') {
      assert(!receipt.createAttempted, 'already-attempted');
      await preflight(receipt, ctx.get, ctx.save);
      await boundaries(receipt, ctx);
      receipt.workPassed = true;
    } else await cleanupOwned(receipt, ctx);
  } catch {
    // Arbitrary SDK/provider diagnostics may contain remote content. Keep only phase status.
    receipt[mode === '--work' ? 'workFailed' : 'cleanupFailed'] = true;
    process.exitCode = 1;
  } finally {
    ctx.guard.close();
    ctx.save();
    ctx.close();
  }
}

export async function runSupervised({
  file,
  receiptPath,
  bundle,
  workMs = WORK_MS,
  cleanupMs = CLEANUP_MS,
  signal,
}) {
  let work;
  let cleanup;
  try {
    work = await supervise(file, ['--work', receiptPath, bundle], workMs, signal);
  } catch {
    work = { spawnFailed: true };
  } finally {
    cleanup = await supervise(file, ['--cleanup', receiptPath, bundle], cleanupMs);
  }
  return { work, cleanup };
}

async function main(targetPath) {
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'use-node22');
  const target = validateTarget(json(resolve(targetPath)));
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    '',
    'commit-before-live',
  );
  const runId = `r01c-${randomUUID()}`;
  const evidence = join(root, '.autopod-data/reliability/r01c', runId);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const receiptPath = join(evidence, 'receipt.json');
  const workspace = mkdtempSync(join(tmpdir(), 'autopod-r01c-'));
  const bundleDir = join(root, 'packages/daemon/.turbo/r01c', runId);
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const built = await buildAdapter(bundleDir);
    const receipt = {
      runId,
      target,
      workspace,
      initialIds: [],
      startedAt: Date.now(),
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      build: built,
      harnessSha256: sha256(readFileSync(here)),
      guardSha256: sha256(readFileSync(join(root, 'scripts/lib/native-sandbox-qualification.mjs'))),
      lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
      nodeVersion: process.version,
      workBudgetMs: WORK_MS,
      cleanupBudgetMs: CLEANUP_MS,
    };
    saveJson(receiptPath, receipt);
    const processes = await runSupervised({
      file: here,
      receiptPath,
      bundle: built.outfile,
      signal: abort.signal,
    });
    const result = json(receiptPath);
    result.processes = processes;
    result.finishedAt = Date.now();
    result.passed =
      result.workPassed === true &&
      result.cleanup?.deletion404 === true &&
      result.cleanup?.unrelatedAndCachePreserved === true &&
      !result.guardFailures?.length &&
      processes.work.code === 0 &&
      processes.cleanup.code === 0;
    saveJson(receiptPath, result);
    console.log(JSON.stringify({ passed: result.passed, receiptPath }));
    if (!result.passed) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, path, bundle] = process.argv.slice(2);
  try {
    if (mode === '--live' && path && !bundle) await main(path);
    else if (['--work', '--cleanup'].includes(mode) && path && bundle)
      await child(mode, path, bundle);
    else throw new Error('usage');
  } catch {
    console.error(
      'Native sandbox qualification incomplete; inspect the private receipt. No diagnostics exported.',
    );
    process.exitCode = 1;
  }
}

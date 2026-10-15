import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  API_VERSION,
  createGuard,
  endpoints,
  sha256,
  validateTarget,
  verifyCache,
} from './lib/native-sandbox-qualification.mjs';
import { buildAdapter, cleanupOwned, runSupervised } from './qualify-native-sandbox.mjs';

const target = {
  subscriptionId: '00000000-0000-0000-0000-000000000000',
  resourceGroup: 'test-rg',
  location: 'northeurope',
  sandboxGroup: 'test-group',
  readyDiskImageId: 'test-disk',
  image: `test.azurecr.io/autopod/test@sha256:${'a'.repeat(64)}`,
  imagePullIdentityResourceId:
    '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/test-identity',
};
const { base } = endpoints(target);
const url = (path) => `${base}${path}?api-version=${API_VERSION}`;
const disk = {
  id: target.readyDiskImageId,
  image: { base: target.image },
  status: { state: 'Ready' },
  labels: {
    managedBy: 'autopod',
    sourceImageHash: sha256(target.image).slice(0, 16),
    sourceDigest: target.image.split('@')[1],
  },
};
const object = {
  id: 'owned-id',
  labels: { managedBy: 'autopod', purpose: 'autopod-sandbox', podId: 'test-run' },
  state: 'Running',
};
const createBody = {
  sourcesRef: { diskImage: { id: target.readyDiskImageId } },
  resources: { cpu: '500m', memory: '1024Mi', disk: '10Gi' },
  lifecycle: { autoSuspendPolicy: { enabled: true, interval: 900, mode: 'Memory' } },
  environment: {},
  egressPolicy: { defaultAction: 'Deny' },
  labels: object.labels,
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(overrides = {}) {
  const receipt = {
    target,
    runId: 'test-run',
    initialIds: ['unrelated-id'],
    preflightPassed: true,
  };
  const calls = [];
  const saved = [];
  const guard = createGuard({
    target,
    receipt,
    save: () => saved.push(structuredClone(receipt)),
    transport: async (input, init) => {
      calls.push({ input, init });
      return response(object);
    },
    ...overrides,
  });
  return { receipt, calls, saved, guard };
}

test('target and immutable cache validation fail closed', () => {
  assert.equal(validateTarget(target), target);
  assert.throws(() => validateTarget({ ...target, image: 'test.azurecr.io/autopod/test:latest' }));
  verifyCache(target, [disk]);
  assert.throws(() => verifyCache(target, [disk, { ...disk, id: 'stale' }]));
  assert.throws(() => verifyCache(target, [{ ...disk, image: { base: 'mutable:latest' } }]));
});

test('HTTP guard blocks forbidden targets, disk/group mutations and unrelated sandboxes before transport', async () => {
  const { guard, calls } = fixture();
  for (const [input, method] of [
    ['https://management.azure.com/something', 'PUT'],
    [url('/diskimages/test-disk'), 'DELETE'],
    [url('/diskimages'), 'PUT'],
    [url('/sandboxes/unrelated-id'), 'DELETE'],
    [url('/sandboxes/owned-id/ports/add'), 'POST'],
    [`${base}other/sandboxes?api-version=${API_VERSION}`, 'GET'],
  ])
    await assert.rejects(guard.fetch(input, { method }));
  assert.equal(calls.length, 0);
});

test('one create receipt is saved before polling; ownership is freshly confirmed before mutation', async () => {
  const { guard, receipt, calls, saved } = fixture();
  await guard.fetch(url('/sandboxes'), { method: 'PUT', body: JSON.stringify(createBody) });
  assert.equal(receipt.acceptedId, object.id);
  assert.equal(saved[0].createAttempted, true);
  assert.equal(saved[0].acceptedId, undefined);
  assert.equal(saved.at(-1).acceptedId, object.id);
  await assert.rejects(
    guard.fetch(url('/sandboxes'), { method: 'PUT', body: JSON.stringify(createBody) }),
  );
  await assert.rejects(guard.fetch(url(`/sandboxes/${object.id}`), { method: 'DELETE' }));
  await guard.fetch(url(`/sandboxes/${object.id}`));
  await guard.fetch(url(`/sandboxes/${object.id}`), { method: 'DELETE' });
  assert.equal(calls.length, 3);
});

test('HTTP deadline covers stalled headers and stalled body and aborts transport', async () => {
  for (const stage of ['headers', 'body']) {
    let observedAbort = false;
    const { guard } = fixture({
      requestMs: 25,
      transport: (_input, { signal }) => {
        if (stage === 'headers')
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => {
              observedAbort = true;
              reject(new Error('aborted'));
            }),
          );
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => {
                observedAbort = true;
                controller.error(new Error('aborted'));
              });
            },
          }),
        );
      },
    });
    await assert.rejects(guard.fetch(url('/sandboxes')));
    assert.equal(observedAbort, true);
  }
});

test('resume permits only the owned empty request during work, never unrelated or cleanup resume', async () => {
  const { guard, calls } = fixture();
  guard.adopt(object);
  await guard.fetch(url(`/sandboxes/${object.id}/resume`), { method: 'POST' });
  await assert.rejects(
    guard.fetch(url(`/sandboxes/${object.id}/resume`), { method: 'POST', body: '{}' }),
    /resume-body-denied/,
  );
  await assert.rejects(
    guard.fetch(url('/sandboxes/unrelated-id/resume'), { method: 'POST' }),
    /unowned-mutation-denied/,
  );
  assert.equal(calls.length, 1);
  const cleanup = fixture({ cleanup: true });
  cleanup.guard.adopt(object);
  await assert.rejects(
    cleanup.guard.fetch(url(`/sandboxes/${object.id}/resume`), { method: 'POST' }),
    /mutation-path-denied/,
  );
  assert.equal(cleanup.calls.length, 0);
});

test('lost create response keeps durable intent and cannot cause a second wire request', async () => {
  let sent = 0;
  const { guard, receipt } = fixture({
    transport: async () => {
      sent++;
      throw new Error('synthetic-lost-response');
    },
  });
  const create = () =>
    guard.fetch(url('/sandboxes'), { method: 'PUT', body: JSON.stringify(createBody) });
  await assert.rejects(create());
  assert.equal(receipt.createAttempted, true);
  assert.equal(receipt.acceptedId, undefined);
  assert.equal(receipt.requests[0].status, null);
  await assert.rejects(create());
  assert.equal(sent, 1);
});

test('WebSocket guard rejects other endpoints/IDs and bounds a stalled connection', async () => {
  let connected = 0;
  let closed = 0;
  const { guard, receipt } = fixture({
    socketMs: 25,
    socketFactory: () => {
      connected++;
      return {
        close() {
          closed++;
        },
        send() {},
      };
    },
  });
  guard.adopt(object);
  const good = `${base.replace('https:', 'wss:')}/sandboxes/${object.id}/exec/stream`;
  assert.throws(() => guard.webSocket(good.replace(object.id, 'unrelated-id'), {}));
  assert.throws(() => guard.webSocket(good.replace('northeurope', 'swedencentral'), {}));
  assert.equal(connected, 0);
  const socket = guard.webSocket(good, {});
  await new Promise((resolve) => {
    socket.onerror = resolve;
  });
  assert.equal(closed, 1);
  assert(receipt.guardFailures.includes('socket-deadline'));
});

test('WebSocket guard preserves frames/headers and closes on oversized output', () => {
  let raw;
  let forwardedHeaders;
  let closes = 0;
  const sent = [];
  const { guard } = fixture({
    socketFactory: (_url, headers) => {
      forwardedHeaders = headers;
      raw = {
        close() {
          closes++;
        },
        send(frame) {
          sent.push(frame);
        },
      };
      return raw;
    },
  });
  guard.adopt(object);
  const headers = { Authorization: 'synthetic-test-only' };
  const socket = guard.webSocket(
    `${base.replace('https:', 'wss:')}/sandboxes/${object.id}/exec/stream`,
    headers,
  );
  assert.equal(forwardedHeaders, headers);
  socket.send('exact outgoing frame');
  assert.deepEqual(sent, ['exact outgoing frame']);
  let observed;
  socket.onmessage = (event) => {
    observed = event;
  };
  const event = { data: 'exact incoming frame' };
  raw.onmessage(event);
  assert.equal(observed, event);
  raw.onmessage({ data: 'x'.repeat(65537) });
  assert.equal(closes, 1);
});

test('cleanup refuses wrong labels and preexisting resources; no delete can occur', async () => {
  for (const bad of [
    { ...object, labels: { ...object.labels, podId: 'someone-else' } },
    { ...object, id: 'unrelated-id' },
  ]) {
    const { guard, receipt } = fixture();
    receipt.createAttempted = true;
    receipt.acceptedId = bad.id;
    let deletes = 0;
    await assert.rejects(
      cleanupOwned(receipt, {
        guard,
        save() {},
        manager: {
          kill() {
            deletes++;
          },
        },
        get: async () => ({ status: 200, body: bad }),
      }),
    );
    assert.equal(deletes, 0);
  }
});

test('cleanup discovers exact owned object after an uncertain create, then proves 404 and preservation', async () => {
  const { guard, receipt } = fixture();
  receipt.createAttempted = true;
  let deleted = false;
  const get = async (path) => {
    if (path === '/diskimages') return { status: 200, body: [disk] };
    if (path === '/sandboxes')
      return { status: 200, body: [{ id: 'unrelated-id' }, ...(deleted ? [] : [object])] };
    return { status: deleted ? 404 : 200, body: deleted ? null : object };
  };
  await cleanupOwned(receipt, {
    guard,
    get,
    save() {},
    manager: {
      async kill(id) {
        assert.equal(id, object.id);
        deleted = true;
      },
    },
  });
  assert.equal(receipt.cleanup.deletion404, true);
  assert.equal(receipt.cleanup.unrelatedAndCachePreserved, true);
});

test('unknown create absence stays unresolved instead of becoming successful teardown', async () => {
  const { guard, receipt } = fixture();
  receipt.createAttempted = true;
  await assert.rejects(
    cleanupOwned(
      receipt,
      { guard, save() {}, manager: {}, get: async () => ({ status: 200, body: [] }) },
      20,
    ),
    /unresolved-create-outcome/,
  );
  assert.equal(receipt.cleanup, undefined);
});

test('supervisor waits for child death before independent cleanup after failure or deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r01c-supervisor-test-'));
  try {
    const file = join(dir, 'child.mjs');
    writeFileSync(
      file,
      `import fs from 'node:fs';
const [mode,path,scenario]=process.argv.slice(2);
if(mode==='--work') {fs.writeFileSync(path,JSON.stringify({acceptedId:'owned-id',pid:process.pid}));
if(scenario==='failure')process.exit(7);setInterval(()=>{},1000);}
else {const r=JSON.parse(fs.readFileSync(path));let dead=false;try{process.kill(r.pid,0)}catch(e){dead=e.code==='ESRCH'}
if(!dead)process.exit(8);fs.writeFileSync(path,JSON.stringify({...r,cleanupRan:true,childGone:dead}));}`,
    );
    for (const scenario of ['failure', 'deadline']) {
      const receiptPath = join(dir, `${scenario}.json`);
      const result = await runSupervised({
        file,
        receiptPath,
        bundle: scenario,
        workMs: 250,
        cleanupMs: 2000,
      });
      const receipt = JSON.parse(readFileSync(receiptPath));
      assert.equal(receipt.acceptedId, 'owned-id');
      assert.equal(receipt.childGone, true);
      assert.equal(receipt.cleanupRan, true);
      assert.equal(result.cleanup.code, 0);
      assert.equal(result.work.timedOut, scenario === 'deadline');
      assert.equal(result.work.code, scenario === 'failure' ? 7 : null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup has its own hard deadline when its child never finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r01c-cleanup-deadline-test-'));
  try {
    const file = join(dir, 'child.mjs');
    writeFileSync(file, "if(process.argv[2]==='--cleanup') setInterval(()=>{},1000);");
    const result = await runSupervised({
      file,
      receiptPath: 'unused',
      bundle: 'unused',
      workMs: 2000,
      cleanupMs: 100,
    });
    assert.equal(result.work.code, 0);
    assert.equal(result.cleanup.timedOut, true);
    assert.equal(result.cleanup.signal, 'SIGKILL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh production source bundle exercises guarded adapter paths including suspended extraction', async () => {
  const dir = mkdtempSync(
    new URL('../packages/daemon/.turbo-r01c-test-', import.meta.url).pathname,
  );
  try {
    const built = await buildAdapter(dir);
    const require = createRequire(import.meta.url);
    const { AzureSandboxApiClient, SandboxContainerManager } = require(built.outfile);
    let deleted = false;
    let createCalls = 0;
    let resumeCalls = 0;
    let state = 'Running';
    let policy = { defaultAction: 'Deny' };
    let uploaded = false;
    let streamFrames = 0;
    const files = new Map();
    const { guard, receipt } = fixture({
      transport: async (input, init) => {
        const request = new URL(input);
        const path = request.pathname.slice(new URL(base).pathname.length);
        if (path === '/diskimages') return response([disk]);
        if (path === `/diskimages/${disk.id}`) return response(disk);
        if (path === '/sandboxes' && init.method === 'PUT') {
          createCalls++;
          return response({ id: object.id }, 202);
        }
        if (path === `/sandboxes/${object.id}`) {
          if (init.method === 'DELETE') deleted = true;
          return deleted
            ? response({}, 404)
            : response({
                ...object,
                state,
                resources: { memory: '1024Mi', cpu: '500m' },
                egressPolicy: policy,
                sourcesRef: { diskImage: { id: disk.id } },
              });
        }
        if (path.endsWith('/resume') && init.method === 'POST') {
          assert.equal(init.body, undefined);
          resumeCalls++;
          state = 'Running';
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/egresspolicy') && init.method === 'POST') {
          policy = JSON.parse(init.body);
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/files')) {
          const file = request.searchParams.get('path');
          if (init.method === 'PUT') {
            files.set(file, Buffer.from(init.body));
            return new Response(null, { status: 204 });
          }
          assert(files.has(file));
          return new Response(files.get(file));
        }
        if (path.endsWith('/files/list')) {
          const folder = request.searchParams.get('path');
          return response({
            path: folder,
            entries: [...files.keys()]
              .filter((file) => file.startsWith(`${folder}/`))
              .map((file) => ({
                name: file.slice(folder.length + 1),
                path: file,
                isDirectory: false,
              })),
          });
        }
        if (path.endsWith('/executeShellCommand') && init.method === 'POST') {
          const { command } = JSON.parse(init.body);
          if (command.includes('autopod-volume-extract')) {
            const archives = [...files].filter(([file]) => file.endsWith('.tar.gz'));
            assert.equal(archives.length, 1);
            assert(gunzipSync(archives[0][1]).includes(Buffer.from('from-host\n')));
            uploaded = true;
            return response({ stdout: '', stderr: '', exitCode: 0 });
          }
          if (command.startsWith('chmod '))
            return response({ stdout: '', stderr: '', exitCode: 0 });
          assert(command.includes('BUFFERED'));
          return response({ stdout: 'BUFFERED', stderr: '', exitCode: 7 });
        }
        assert.fail('unexpected synthetic request');
      },
      socketFactory: () => {
        const socket = {
          close() {},
          send(frame) {
            const start = JSON.parse(frame);
            assert.equal(start.type, 'start');
            assert(files.get(start.start.command).includes(Buffer.from('STREAM')));
            queueMicrotask(() => {
              for (const event of [
                { type: 'stdout', data: Buffer.from('STREAM').toString('base64') },
                { type: 'stderr', data: Buffer.from('ERR').toString('base64') },
                { type: 'exit_code', exitCode: 7 },
              ]) {
                streamFrames++;
                socket.onmessage({ data: JSON.stringify(event) });
              }
            });
          },
        };
        queueMicrotask(() => socket.onopen({}));
        return socket;
      },
    });
    const logger = {
      child() {
        return this;
      },
      info() {},
      warn() {},
      debug() {},
    };
    const client = new AzureSandboxApiClient(
      {
        ...target,
        assumeGroupExists: true,
        credential: {
          async getToken() {
            return { token: 'synthetic-test-only' };
          },
        },
        fetch: guard.fetch,
        webSocket: guard.webSocket,
        retry: { maxAttempts: 1 },
        pollIntervalMs: 1,
      },
      logger,
    );
    const manager = new SandboxContainerManager(client, logger, { defaultTier: 'S' });
    const inputDir = join(dir, 'input');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'input.txt'), 'from-host\n');
    assert.equal(
      await manager.spawn({
        image: target.image,
        podId: receipt.runId,
        env: {},
        networkPolicyMode: 'deny-all',
        volumes: [{ host: inputDir, container: '/mnt/worktree' }],
      }),
      object.id,
    );
    assert.equal(createCalls, 1);
    assert.equal(receipt.acceptedId, object.id);
    assert.equal(uploaded, true);
    assert.equal(await client.getImageDigest(object.id), target.image.split('@')[1]);
    assert.deepEqual(await client.getResourceAllocation(object.id), {
      memoryLimitBytes: 2 ** 30,
      cpuLimit: 0.5,
    });
    assert.deepEqual(
      await manager.execInContainer(object.id, ['sh', '-c', 'printf BUFFERED; exit 7']),
      { stdout: 'BUFFERED', stderr: '', exitCode: 7 },
    );
    const streaming = await manager.execStreaming(object.id, ['sh', '-c', 'printf STREAM; exit 7']);
    let stdout = '';
    let stderr = '';
    streaming.stdout.on('data', (value) => {
      stdout += value;
    });
    streaming.stderr.on('data', (value) => {
      stderr += value;
    });
    const [streamExit] = await Promise.all([
      streaming.exitCode,
      finished(streaming.stdout),
      finished(streaming.stderr),
    ]);
    assert.equal(streamExit, 7);
    assert.equal(stdout, 'STREAM');
    assert.equal(stderr, 'ERR');
    assert.equal(streamFrames, 3);
    await manager.writeFile(object.id, '/workspace/synthetic/input.txt', 'from-host\n');
    await manager.writeFile(object.id, '/workspace/synthetic/output.txt', 'from-sandbox\n');
    assert.equal(
      await manager.readFile(object.id, '/workspace/synthetic/input.txt'),
      'from-host\n',
    );
    state = 'Suspended'; // Running would early-return and hide the missing resume allowlist entry.
    const outputDir = join(dir, 'output');
    await manager.extractDirectoryFromContainer(object.id, '/workspace/synthetic', outputDir, [
      'node_modules',
    ]);
    assert.equal(resumeCalls, 1);
    assert.equal(readFileSync(join(outputDir, 'input.txt'), 'utf8'), 'from-host\n');
    assert.equal(readFileSync(join(outputDir, 'output.txt'), 'utf8'), 'from-sandbox\n');
    await manager.refreshFirewall(
      object.id,
      JSON.stringify({ sandboxEgressPolicy: { defaultAction: 'Deny', hostRules: [] } }),
    );
    assert.deepEqual(policy, { defaultAction: 'Deny' });
    await manager.kill(object.id);
    await manager.kill(object.id);
    assert.equal(deleted, true);
    assert.equal(receipt.guardFailures, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

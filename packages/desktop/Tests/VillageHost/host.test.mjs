import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
  new URL('../../Sources/AutopodUI/Resources/Village/host.js', import.meta.url),
  'utf8',
);
const fixture = JSON.parse(await readFile(new URL('./scene.json', import.meta.url), 'utf8'));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(plugin = {}) {
  const messages = [];
  const renders = [];
  const listeners = {};
  let select;
  let disposed = 0;
  const window = {
    webkit: { messageHandlers: { village: { postMessage: (m) => messages.push(m) } } },
    addEventListener: (key, fn) => {
      listeners[key] = fn;
    },
    AutoPodVillageRenderer: {
      schemaVersion: 1,
      create(options) {
        select = options.onSelect;
        return {
          render: (s) => renders.push(s),
          dispose: () => {
            disposed++;
          },
        };
      },
      ...plugin,
    },
  };
  vm.runInNewContext(source, { window, document: { getElementById: () => ({}) } });
  await tick();
  return {
    messages,
    renders,
    listeners,
    window,
    host: window.AutoPodVillageHost,
    select: (id) => select(id),
    disposed: () => disposed,
  };
}

test('renderer handshake and fixture use the same version; no data arrives before ready', async () => {
  const s = await setup();
  assert.equal(s.messages[0].type, 'ready');
  assert.equal(s.messages[0].schemaVersion, fixture.schemaVersion);
  assert.equal(s.renders.length, 0);
  assert.equal(s.host.receive(fixture), true);
  assert.equal(s.renders.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s.renders[0])), fixture);
  assert.ok(Object.isFrozen(s.renders[0].actors[0]));
  assert.ok(Object.isFrozen(s.renders[0].actors[0].activity));
  assert.notEqual(s.renders[0], fixture);
});

test('selection preserves native/managed namespaces and rejects removed or fabricated actors', async () => {
  const s = await setup();
  s.host.receive(fixture);
  s.select('managed:pod-a');
  assert.equal(s.messages.at(-1).actorId, 'managed:pod-a');
  const before = s.messages.length;
  s.select('pod-a');
  s.select('native:missing');
  s.host.receive({ ...fixture, actors: [] });
  s.select('native:pod-a');
  assert.equal(s.messages.length, before);
});

test('full snapshots replace removed actors and preserve disconnect/reduced-motion flags', async () => {
  const s = await setup();
  s.host.receive(fixture);
  s.host.receive({
    ...fixture,
    connected: false,
    activityStreamConnected: false,
    managedDataFresh: false,
    actors: [],
  });
  assert.equal(s.renders[1].actors.length, 0);
  assert.equal(s.renders[1].connected, false);
  assert.equal(s.renders[1].reducedMotion, true);
});

test('unsupported versions, duplicate identity and malformed snapshots never reach the renderer', async () => {
  const s = await setup();
  for (const value of [
    null,
    {},
    { ...fixture, schemaVersion: 2 },
    { ...fixture, actors: [fixture.actors[0], fixture.actors[0]] },
    { ...fixture, actors: [{ ...fixture.actors[0], id: 'managed:pod-a' }] },
  ]) {
    assert.throws(() => s.host.receive(value));
  }
  assert.equal(s.renders.length, 0);
});

test('renderer version mismatch and asset failures report errors instead of ready', async () => {
  for (const plugin of [
    { schemaVersion: 2 },
    {
      create: async () => {
        throw new Error('asset');
      },
    },
  ]) {
    const s = await setup(plugin);
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].type, 'error');
  }
});

test('dispose cancels selection and updates and calls renderer cleanup once', async () => {
  const s = await setup();
  s.host.receive(fixture);
  s.listeners.pagehide();
  s.host.dispose();
  assert.equal(s.disposed(), 1);
  const before = s.messages.length;
  s.select('native:pod-a');
  assert.equal(s.messages.length, before);
  assert.throws(() => s.host.receive(fixture), /not ready/);
});

test('an asynchronously loaded renderer is disposed if the view leaves before ready', async () => {
  let finish;
  let disposed = 0;
  const s = await setup({
    create: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  assert.equal(s.messages.length, 0);
  s.host.dispose();
  finish({
    render() {},
    dispose() {
      disposed++;
    },
  });
  await tick();
  assert.equal(disposed, 1);
  assert.equal(s.messages.length, 0);
});

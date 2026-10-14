import assert from 'node:assert/strict';
import test from 'node:test';
import { ROSTER } from '../../Sources/AutopodUI/Resources/Village/renderer/upstream/src/cast.mjs';
import { pointOnRoute, presentation, skinFor } from '../../VillageRenderer/live-scene.mjs';

const snapshot = {
  connected: true,
  activityStreamConnected: true,
  managedDataFresh: true,
  reducedMotion: false,
};
const native = {
  id: 'native:a',
  source: 'native',
  stage: 'working',
  status: 'running',
  interactive: false,
  activity: { kind: 'edit', isRecent: true, observedAt: 1000, label: 'Editing' },
};

test('recent native activity chooses workshop but expires without changing pod stage', () => {
  assert.equal(presentation(native, snapshot, 2000).station, 'workshop');
  assert.equal(presentation(native, snapshot, 31001).station, 'square');
  assert.equal(presentation(native, snapshot, 999).activity, null);
  assert.equal(presentation({ ...native, stage: 'failed' }, snapshot, 2000).station, 'noticeboard');
  assert.equal(presentation({ ...native, stage: 'complete' }, snapshot, 2000).station, 'camp');
});

test('managed, interactive and disconnected pods never invent native tool work', () => {
  const managed = presentation({ ...native, source: 'managed' }, snapshot, 2000);
  assert.equal(managed.activity, null);
  assert.ok(managed.scale < presentation(native, snapshot, 2000).scale);
  assert.equal(presentation({ ...native, interactive: true }, snapshot, 2000).motion, false);
  for (const key of ['connected', 'activityStreamConnected']) {
    const view = presentation(native, { ...snapshot, [key]: false }, 2000);
    assert.equal(view.motion, false);
    assert.equal(view.activity, null);
    assert.equal(view.label, 'Last known state');
  }
  assert.equal(
    presentation({ ...native, source: 'managed' }, { ...snapshot, managedDataFresh: false }, 2000)
      .motion,
    false,
  );
  const reduced = presentation(native, { ...snapshot, reducedMotion: true }, 2000);
  assert.equal(reduced.motion, false);
  assert.equal(reduced.station, 'workshop');
});

test('routes follow authored segments and finish at their seat', () => {
  const route = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  assert.deepEqual(pointOnRoute(route, 1.5), { position: [1, 0.5], moving: true, direction: 0 });
  assert.deepEqual(pointOnRoute(route, 10), { position: [1, 1], moving: false, direction: 0 });
  assert.deepEqual(pointOnRoute([[0.5, 0.5]], 0).position, [0.5, 0.5]);
  assert.equal(skinFor('native:a', ROSTER), skinFor('native:a', ROSTER));
});

test('live pods use the complete upstream roster with stable identity', () => {
  const species = new Set(
    Array.from({ length: 120 }, (_, i) => skinFor(`native:pod-${i}`, ROSTER)),
  );
  assert.deepEqual([...species].sort(), [...ROSTER].sort());
  assert.equal(ROSTER.length, 12);
});

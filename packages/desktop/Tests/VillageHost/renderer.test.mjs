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
  assert.equal(managed.station, 'square');
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

import {
  actorAtScreen,
  cameraAt,
  worldToScreen,
} from '../../Sources/AutopodUI/Resources/Village/renderer/upstream/src/camera.mjs';
import { performanceAt } from '../../Sources/AutopodUI/Resources/Village/renderer/upstream/src/performance.mjs';
import { sceneAt } from '../../Sources/AutopodUI/Resources/Village/renderer/upstream/src/timeline.mjs';
import {
  stationRoute,
  stationSeat,
} from '../../Sources/AutopodUI/Resources/Village/renderer/upstream/src/world.mjs';
// Run the actual pinned scene engine against the live adapter, not a mock replay.
import { createLiveTimeline } from '../../VillageRenderer/live-timeline.mjs';

const liveActor = { ...native, podId: 'a' };
const liveAdapter = () => createLiveTimeline({ roster: ROSTER, stationRoute, stationSeat });

test('live observations drive upstream acting without inventing managed activity or completion', () => {
  const live = liveAdapter();
  const actors = [liveActor, { ...liveActor, id: 'managed:a', source: 'managed' }];
  let timeline = live.update({ ...snapshot, actors }, 2000, 10);
  let state = sceneAt(timeline, 10);
  assert.equal(
    performanceAt(
      state.actors.find((a) => a.id === 'native:a'),
      10,
    ).mode,
    'hammer',
  );
  assert.equal(
    performanceAt(
      state.actors.find((a) => a.id === 'managed:a'),
      10,
    ).mode,
    'idle',
  );
  assert.equal(timeline.recap, undefined);
  assert.equal(timeline.retirements, undefined);
  timeline = live.update({ ...snapshot, actors }, 32000, 40);
  state = sceneAt(timeline, 60);
  assert.equal(
    performanceAt(
      state.actors.find((a) => a.id === 'native:a'),
      60,
    ).mode,
    'idle',
  );
  assert.equal(state.actors.length, 2, 'silence never retires a pod');
  timeline = live.update({ ...snapshot, actors: [] }, 33000, 61);
  assert.equal(sceneAt(timeline, 61).actors.length, 0, 'snapshot removal retires immediately');
});

test('upstream routes and follow hit testing survive an interrupting lifecycle change', () => {
  const live = liveAdapter();
  live.update({ ...snapshot, actors: [liveActor] }, 2000, 10);
  let timeline = live.update(
    { ...snapshot, actors: [{ ...liveActor, activity: { ...liveActor.activity, kind: 'read' } }] },
    3000,
    11,
  );
  assert.equal(sceneAt(timeline, 11.1).actors[0].moving, true);
  const failed = { ...liveActor, stage: 'failed', status: 'failed' };
  timeline = live.update({ ...snapshot, actors: [failed] }, 4000, 12);
  const state = sceneAt(timeline, 12);
  assert.equal(state.actors[0].moving, false);
  assert.deepEqual(state.actors[0].position, stationSeat('noticeboard', 0, 1));
  assert.equal(state.actors[0].scene.status, 'failed');
  state.camera = cameraAt(timeline, state, { focus: failed.id, mode: 'follow', motion: false });
  assert.equal(state.camera.scale, 2);
  const [x, y] = worldToScreen(state.camera, state.actors[0].position);
  assert.equal(actorAtScreen(state, x, y - 20 * state.camera.scale).id, failed.id);
  assert.equal(actorAtScreen(state, x, 800), null, 'status panel is not a map hit target');
});

test('disconnection and reduced motion snap travel without displaying recent work', () => {
  const live = liveAdapter();
  live.update({ ...snapshot, actors: [liveActor] }, 2000, 10);
  const disconnected = { ...snapshot, connected: false, actors: [liveActor] };
  const state = sceneAt(live.update(disconnected, 3000, 11), 11);
  assert.equal(state.actors[0].moving, false);
  assert.equal(performanceAt(state.actors[0], 11, { motion: false }).mode, 'idle');
  assert.match(state.current.text, /Last known state/);
});

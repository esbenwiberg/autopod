import type { PodProfileDisplay } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

const PROFILE_ID = '76f0c4b8-0000-4000-8000-0fe13ce164f7';

describe('credential-free profile display', () => {
  let db: ReturnType<typeof createTestDb>;
  let pods: ReturnType<typeof createPodRepository>;
  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db, { name: PROFILE_ID });
    insertTestProfile(db, { name: 'legacy-app' });
    pods = createPodRepository(db);
    pods.insert({
      id: 'profile-pod',
      profileName: PROFILE_ID,
      task: 'Task',
      status: 'queued',
      model: 'model',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'task',
      userId: 'user',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
  });
  afterEach(() => db.close());

  function snapshot(payload: unknown, phase = false, digest = 'captured') {
    db.prepare('UPDATE pods SET launch_config_digest=? WHERE id=?').run(digest, 'profile-pod');
    const json = JSON.stringify(payload);
    if (phase)
      db.prepare(`INSERT INTO pod_launch_phases(pod_id,digest,parent_digest,payload,created_at)
      VALUES ('profile-pod',?,'original',?,datetime('now'))`).run(digest, json);
    else
      db.prepare(`INSERT INTO pod_launch_snapshots(pod_id,digest,payload,request_digest,created_at)
      VALUES ('profile-pod',?,?,'request',datetime('now'))`).run(digest, json);
  }
  function captured(name = 'Works Claude') {
    return {
      profileId: PROFILE_ID,
      revisions: [{ id: PROFILE_ID, kind: 'profile', name }],
      secrets: 'never-return-this'.repeat(40_000),
    };
  }
  function entity(archived = false) {
    db.prepare(`INSERT INTO configuration_entities(id,kind,name,revision,archived,created_at,updated_at)
      VALUES (?,'profile','Renamed profile',2,?,datetime('now'),datetime('now'))`).run(
      PROFILE_ID,
      Number(archived),
    );
  }
  function expectEveryProjection(display: PodProfileDisplay) {
    expect(pods.getProfileForDisplay?.('profile-pod')).toEqual(display);
    for (const pod of [
      pods.listCompactForDisplay?.()[0],
      pods.listForDisplay?.()[0],
      pods.listForHistory()[0],
    ]) {
      expect(pod?.profileName).toBe(PROFILE_ID);
      expect(pod?.profileDisplay).toEqual(display);
    }
    expect(pods.getOrThrow('profile-pod').profileName).toBe(PROFILE_ID);
    expect(pods.list({ profileName: PROFILE_ID })).toHaveLength(1);
  }

  it('uses launch-time names, preserves identity and never parses the full launch in Node', () => {
    entity();
    snapshot(captured());
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      if (args[0].includes('never-return-this')) throw new Error('Full launch crossed into Node');
      return parse(...args);
    });
    try {
      expectEveryProjection({ id: PROFILE_ID, name: 'Works Claude', state: 'active' });
    } finally {
      spy.mockRestore();
    }
  });
  it('preserves names for archived and deleted profiles instead of relabeling or recreating them', () => {
    snapshot(captured());
    entity(true);
    expectEveryProjection({ id: PROFILE_ID, name: 'Works Claude', state: 'archived' });
    db.prepare('DELETE FROM configuration_entities WHERE id=?').run(PROFILE_ID);
    expectEveryProjection({ id: PROFILE_ID, name: 'Works Claude', state: 'deleted' });
  });
  it('reads the matching active phase, not the original name', () => {
    snapshot(captured('Original'), false, 'original');
    snapshot(captured('Phase profile'), true, 'phase');
    entity();
    expectEveryProjection({ id: PROFILE_ID, name: 'Phase profile', state: 'active' });
  });
  it('rejects embedded NUL before SQLite can return an unbounded display string', () => {
    entity();
    snapshot(captured(`x\0${'y'.repeat(500_000)}`));
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      if (args[0].length > 1024) throw new Error('Unbounded label crossed into Node');
      return parse(...args);
    });
    try {
      expectEveryProjection({ id: PROFILE_ID, name: null, state: 'unavailable' });
    } finally {
      spy.mockRestore();
    }
  });

  it('handles legacy names without pretending they are composable IDs', () => {
    db.prepare("UPDATE pods SET profile_name='legacy-app' WHERE id='profile-pod'").run();
    expect(pods.getProfileForDisplay?.('profile-pod')).toEqual({
      id: null,
      name: 'legacy-app',
      state: 'legacy',
    });
  });
  it('does not borrow a mutable name when the matching snapshot is missing', () => {
    entity();
    db.prepare("UPDATE pods SET launch_config_digest='missing' WHERE id='profile-pod'").run();
    expectEveryProjection({ id: PROFILE_ID, name: null, state: 'unavailable' });
  });
  it.each([
    {},
    {
      profileId: PROFILE_ID,
      revisions: [{ id: PROFILE_ID, kind: 'profile', name: 'Works'.padEnd(256) }],
    },
    { profileId: PROFILE_ID, revisions: ['not JSON', null, 42] },
    { profileId: PROFILE_ID, revisions: { name: 'Wrong shape' } },
    { profileId: PROFILE_ID, revisions: [{ id: PROFILE_ID, kind: 'ai', name: 'Wrong kind' }] },
    {
      profileId: PROFILE_ID,
      revisions: [{ id: 'other', kind: 'profile', name: 'Wrong identity' }],
    },
    {
      profileId: 'other',
      revisions: [{ id: 'other', kind: 'profile', name: 'Wrong pod identity' }],
    },
    {
      profileId: PROFILE_ID,
      revisions: [{ id: PROFILE_ID, kind: 'profile', name: 'x'.repeat(129) }],
    },
  ])('keeps malformed/mismatched/oversized display metadata unavailable: %j', (payload) => {
    snapshot(payload);
    expectEveryProjection({ id: PROFILE_ID, name: null, state: 'unavailable' });
  });
});

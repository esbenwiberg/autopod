import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture, flushAdmission } from '../test-utils/admission-queries-helpers.js';
describe('complete legacy admission', () => {
  it('persists creation metadata and safe interactive branch through real SQLite reopen', async () => {
    const f = createAdmissionFixture(true);
    const profile = f.profiles.get('test-profile');
    const p = f.legacy().createSession(
      {
        profileName: 'test-profile',
        task: 'Legacy metadata',
        branch: 'main',
        baseBranch: 'main',
        outputMode: 'workspace',
        handoffInstructions: '  carry this  ',
        specContextFiles: [{ path: 'design.md', content: 'Frozen text' }],
        tokenBudget: 23,
      },
      'operator',
      { name: 'Owner', email: 'owner@invalid.example' },
    );
    expect(p).toMatchObject({
      creatorName: 'Owner',
      handoffInstructions: 'carry this',
      tokenBudget: 23,
    });
    expect(p.branch).not.toBe('main');
    expect(f.enqueueSession).toHaveBeenCalledWith(p.id);
    const next = f.reopen();
    expect(next.pods.getOrThrow(p.id)).toEqual(p);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('publishes after transaction commit and never publishes a rolled-back row', async () => {
    const f = createAdmissionFixture(true);
    let id = '';
    f.db.transaction(() => {
      id = f
        .legacy()
        .createSession({ profileName: 'test-profile', task: 'Committed row' }, 'operator').id;
      expect(f.enqueueSession).not.toHaveBeenCalled();
    })();
    await flushAdmission();
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith(id);
    f.enqueueSession.mockClear();
    const before = f.podRepo.list().length;
    expect(() =>
      f.db.transaction(() => {
        f.legacy().createSession({ profileName: 'test-profile', task: 'Rolled back' }, 'operator');
        throw new Error('Synthetic rollback');
      })(),
    ).toThrow('Synthetic rollback');
    await flushAdmission();
    expect(f.enqueueSession).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(next.pods.list()).toHaveLength(before);
    expect(next.pods.getOrThrow(id).task).toBe('Committed row');
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('refuses old API on native configuration and unauthorized intentional rerun before insert', () => {
    const f = createAdmissionFixture();
    f.live.launchConfiguration = {
      read: () => null,
      executionSettings: () => f.profiles.get('test-profile'),
      assertCurrentCapabilities: async () => {},
    };
    expect(() =>
      f.legacy().createSession({ profileName: 'test-profile', task: 'Old API' }, 'operator'),
    ).toThrow('requires a resolved');
    f.live.launchConfiguration = undefined;
    expect(() =>
      f.legacy().createSession(
        {
          profileName: 'test-profile',
          task: 'rerun',
          intentionalRerun: {
            reason: 'Synthetic decision',
            ofPodId: 'prepare',
            requestKey: 'rerun-id',
          },
        },
        'operator',
      ),
    ).toThrow('authenticated human');
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('retains original sidecar/network and skip-validation gates', () => {
    const f = createAdmissionFixture();
    expect(() =>
      f.legacy().createSession(
        {
          profileName: 'test-profile',
          task: 'invalid',
          skipValidation: true,
          options: { validationSuite: 'custom' },
        },
        'operator',
      ),
    ).toThrow('skipValidation');
    f.profiles.update('test-profile', {
      networkPolicy: { enabled: true, mode: 'deny-all', allowedHosts: [] },
    });
    expect(() =>
      f.legacy().createSession({ profileName: 'test-profile', task: 'denied' }, 'operator'),
    ).toThrow('deny-all');
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('does not enqueue dependents and preserves shared single-PR source binding', () => {
    const f = createAdmissionFixture();
    const parent = f.insert('parent', {
      branch: 'shared',
      baseBranch: 'release',
      seriesId: 'series',
      prMode: 'single',
    });
    const child = f.legacy().createSession(
      {
        profileName: 'test-profile',
        task: 'child',
        dependsOnPodIds: [parent.id],
        seriesId: 'series',
        prMode: 'single',
      },
      'operator',
    );
    expect(child).toMatchObject({ branch: 'shared', baseBranch: 'release' });
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('keeps original warn/block and best-effort overlap inspection behavior', () => {
    const f = createAdmissionFixture();
    f.profiles.update('test-profile', {
      repoUrl: 'https://github.com/org/repo',
    });
    f.db
      .prepare("UPDATE profiles SET preflight_conflict_policy = 'block' WHERE name = ?")
      .run('test-profile');
    f.insert('busy', { touches: ['src/**'], baseBranch: 'main' });
    expect(f.profiles.get('test-profile').preflightConflictPolicy).toBe('block');
    expect(f.podRepo.getOrThrow('busy').touches).toEqual(['src/**']);
    expect(f.context.executionForPod(f.podRepo.getOrThrow('busy')).repoUrl).toBe(
      'https://github.com/org/repo',
    );
    expect(() =>
      f
        .legacy()
        .createSession(
          { profileName: 'test-profile', task: 'overlap', touches: ['src/a.ts'] },
          'operator',
        ),
    ).toThrow('blocked');
    vi.spyOn(f.podRepo, 'listNonTerminal').mockImplementationOnce(() => {
      throw new Error('Synthetic projection failure');
    });
    const p = f
      .legacy()
      .createSession(
        { profileName: 'test-profile', task: 'fallthrough', touches: ['src/a.ts'] },
        'operator',
      );
    expect(f.enqueueSession).toHaveBeenCalledWith(p.id);
  });
});

it('retains actual authenticated rerun receipt/replay through a private SQLite reopen', async () => {
  const f = createAdmissionFixture(true);
  const owner = f.legacy();
  const request = { profileName: 'test-profile', task: 'Repeat this exact logical request' };
  const source = owner.createSession(request, 'operator');
  f.enqueueSession.mockClear();
  const rerun = {
    ...request,
    intentionalRerun: {
      ofPodId: source.id,
      requestKey: 'slice32-rerun',
      reason: 'Explicit human repeat',
    },
  };
  const actor = { type: 'human' as const, userId: 'operator' };
  const repeated = owner.createSession(rerun, 'operator', undefined, actor);
  expect(repeated.id).not.toBe(source.id);
  expect(
    f.db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(repeated.id),
  ).not.toEqual(f.db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(source.id));
  expect(owner.createSession(rerun, 'operator', undefined, actor).id).toBe(repeated.id);
  expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith(repeated.id);
  const saved = f.db
    .prepare('SELECT * FROM execution_rerun_intents WHERE pod_id=?')
    .get(repeated.id);
  const next = f.reopen();
  expect(next.pods.dispatchPreflight?.findRerun(rerun, 'operator')).toBe(repeated.id);
  expect(
    f.db.prepare('SELECT * FROM execution_rerun_intents WHERE pod_id=?').get(repeated.id),
  ).toEqual(saved);
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});
it('keeps the ten-attempt legacy uniqueness policy and propagates other insert errors immediately', () => {
  const f = createAdmissionFixture();
  const insert = vi.spyOn(f.podRepo, 'insert').mockImplementation(() => {
    throw new Error('UNIQUE constraint failed: synthetic.other');
  });
  expect(() =>
    f.legacy().createSession({ profileName: 'test-profile', task: 'unique' }, 'operator'),
  ).toThrow('synthetic.other');
  expect(insert).toHaveBeenCalledTimes(10);
  expect(f.enqueueSession).not.toHaveBeenCalled();
  insert.mockClear();
  insert.mockImplementation(() => {
    throw new Error('Synthetic storage failure');
  });
  expect(() =>
    f.legacy().createSession({ profileName: 'test-profile', task: 'storage' }, 'operator'),
  ).toThrow('storage failure');
  expect(insert).toHaveBeenCalledOnce();
});

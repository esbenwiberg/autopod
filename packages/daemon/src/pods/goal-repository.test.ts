import { describe, expect, it } from 'vitest';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { type GoalRepository, createGoalRepository } from './goal-repository.js';
import { createTaskHistoryArchive } from './task-history-archive.js';

function goal(repo: GoalRepository) {
  const value = repo.get('pod');
  if (!value) throw new Error('Expected goal');
  return value;
}

describe('native goal state', () => {
  it.each(['preserved', 'reset'] as const)(
    'keeps usage across confirmed resume with %s native counters',
    (counterMode) => {
      const db = createTestDb();
      try {
        insertConfigurationTestPod(db, 'pod');
        const repo = createGoalRepository(db);
        const initial = repo.create('pod', 'Tests pass', 'codex');
        const first = { generation: 1, attemptId: 'first' };
        repo.beginAttempt('pod', initial.revision, first, 'codex');
        repo.bindSession('pod', first, 'native-session');
        const observation = {
          nativeSessionId: 'native-session',
          objective: 'Tests pass',
          state: 'active' as const,
          nativeStatus: 'active',
          sequence: 1,
          cumulativeTokens: 100,
          cumulativeSeconds: 10,
        };
        repo.observe('pod', first, observation);
        repo.observe('pod', first, observation);
        expect(repo.get('pod')?.observedTokens).toBe(100);
        expect(repo.canComplete('pod')).toBe(false);
        const current = goal(repo);
        repo.requestControl('pod', current.revision, 'pause');
        expect(() =>
          repo.beginAttempt(
            'pod',
            goal(repo).revision,
            { generation: 1, attemptId: 'too-early' },
            'codex',
          ),
        ).toThrow('Confirm');
        repo.confirmStopped('pod', first);
        const restarted = createGoalRepository(db);
        const next = { generation: 1, attemptId: 'resumed' };
        expect(() =>
          restarted.beginAttempt('pod', goal(restarted).revision, next, 'codex', counterMode),
        ).toThrow('explicitly');
        restarted.requestControl('pod', goal(restarted).revision, 'resume');
        restarted.beginAttempt('pod', goal(restarted).revision, next, 'codex', counterMode);
        restarted.observe('pod', next, {
          ...observation,
          cumulativeTokens: counterMode === 'reset' ? 20 : 120,
          cumulativeSeconds: counterMode === 'reset' ? 2 : 12,
          state: 'achieved',
          nativeStatus: 'complete',
        });
        expect(restarted.get('pod')?.observedTokens).toBe(120);
        expect(restarted.canComplete('pod')).toBe(false);
        restarted.confirmStopped('pod', next);
        expect(restarted.canComplete('pod')).toBe(true);
        const archive = createTaskHistoryArchive(db);
        db.transaction(() => {
          archive('pod');
          db.prepare('DELETE FROM pods WHERE id=?').run('pod');
        })();
        expect(restarted.get('pod')).toMatchObject({ state: 'achieved', observedTokens: 120 });
      } finally {
        db.close();
      }
    },
  );
  it('rejects objective changes, unexplained counter resets and late success after cancellation', () => {
    const db = createTestDb();
    try {
      insertConfigurationTestPod(db, 'pod');
      const repo = createGoalRepository(db);
      const fence = { generation: 2, attemptId: 'a' };
      const initial = repo.create('pod', 'Tests pass', 'codex');
      repo.beginAttempt('pod', initial.revision, fence, 'codex');
      repo.bindSession('pod', fence, 'native');
      const observation = {
        nativeSessionId: 'native',
        objective: 'Tests pass',
        state: 'active' as const,
        nativeStatus: 'active',
        sequence: 1,
        cumulativeTokens: 100,
        cumulativeSeconds: 10,
      };
      repo.observe('pod', fence, observation);
      expect(() =>
        repo.observe('pod', fence, { ...observation, sequence: 2, cumulativeTokens: 0 }),
      ).toThrow('reset');
      expect(() => repo.observe('pod', fence, { ...observation, objective: 'Different' })).toThrow(
        'identity',
      );
      repo.requestControl('pod', goal(repo).revision, 'cancel');
      repo.observe('pod', fence, {
        ...observation,
        sequence: 2,
        state: 'achieved',
        cumulativeTokens: 110,
      });
      repo.confirmStopped('pod', fence);
      repo.observe('pod', fence, { ...observation, sequence: 3, state: 'achieved' });
      expect(repo.get('pod')).toMatchObject({ state: 'cancelled', observedTokens: 110 });
      expect(repo.canComplete('pod')).toBe(false);
    } finally {
      db.close();
    }
  });
});

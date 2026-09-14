import { describe, expect, it } from 'vitest';
import { createTaskHistoryArchive } from '../pods/task-history-archive.js';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createGitHubOperationLedger } from './operation-ledger.js';

describe('GitHub operation ledger', () => {
  it('claims a write once, persists its receipt and rejects changed retry payloads', () => {
    const db = createTestDb();
    try {
      insertConfigurationTestPod(db, 'pod');
      const ledger = createGitHubOperationLedger(db);
      const decision = { snapshotRuleId: 'saved', ceilingRuleId: 'current' };
      const input = {
        podId: 'pod',
        operationKey: 'once',
        operation: 'issues.comment' as const,
        repositoryId: '1',
        snapshotDigest: 'snapshot',
        decision,
        parameters: { number: 1, body: 'Test comment' },
      };
      expect(ledger.reserve(input).state).toBe('ready');
      expect(ledger.claim('pod', 'once', decision)).toBe(true);
      expect(ledger.claim('pod', 'once', decision)).toBe(false);
      ledger.settle('pod', 'once', {
        state: 'succeeded',
        receipt: { accepted: true, providerId: 'comment-1' },
      });
      expect(createGitHubOperationLedger(db).reserve(input).receipt?.providerId).toBe('comment-1');
      expect(() =>
        ledger.reserve({ ...input, parameters: { number: 2, body: 'Test comment' } }),
      ).toThrow('different parameters');
      expect(() => ledger.settle('pod', 'once', { state: 'uncertain', code: 'late' })).toThrow(
        'current state',
      );
    } finally {
      db.close();
    }
  });
  it('retains uncertain workflow dispatches across recovery without reopening them for retry', () => {
    const db = createTestDb();
    try {
      insertConfigurationTestPod(db, 'pod');
      const ledger = createGitHubOperationLedger(db);
      const decision = { snapshotRuleId: 'saved', ceilingRuleId: 'current' };
      const input = {
        podId: 'pod',
        operationKey: 'dispatch',
        operation: 'workflows.dispatch' as const,
        repositoryId: '1',
        snapshotDigest: 'snapshot',
        decision,
        parameters: { workflow: 'ci.yml', branch: 'main' },
      };
      ledger.reserve(input);
      ledger.claim('pod', 'dispatch', decision);
      const restarted = createGitHubOperationLedger(db);
      expect(restarted.recoverInterrupted()).toBe(1);
      expect(restarted.reserve(input).state).toBe('uncertain');
      expect(restarted.claim('pod', 'dispatch', decision)).toBe(false);
      expect(restarted.recoverInterrupted()).toBe(0);
      const archive = createTaskHistoryArchive(db);
      db.transaction(() => {
        archive('pod');
        db.prepare('DELETE FROM pods WHERE id=?').run('pod');
      })();
      expect(createGitHubOperationLedger(db).reserve(input).state).toBe('uncertain');
      expect(restarted.claim('pod', 'dispatch', decision)).toBe(false);
    } finally {
      db.close();
    }
  });
});

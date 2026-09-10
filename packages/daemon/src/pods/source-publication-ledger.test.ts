import { describe, expect, it } from 'vitest';
import type { BranchPublicationReceipt } from '../interfaces/worktree-manager.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createSourcePublicationLedger } from './source-publication-ledger.js';

const proof: BranchPublicationReceipt = {
  branch: 'feature',
  repository: 'https://github.com/org/repo',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  remoteRef: 'refs/heads/feature',
  observedRemoteCommitSha: 'a'.repeat(40),
  worktreeClean: true,
  observedAt: '2026-09-07T12:00:00Z',
};
function fixture(db = createTestDb()) {
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'source',
    profileName: 'test-profile',
    task: 'Publish source',
    model: 'model',
    runtime: 'codex',
    branch: 'feature',
    userId: 'user',
    status: 'validated',
    executionTarget: 'local',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('source', { worktreePath: '/tmp/source', containerId: 'source-container' });
  return { db, repo, ledger: createSourcePublicationLedger(db), pod: repo.getOrThrow('source') };
}
describe('durable source publication', () => {
  it('refuses admission inside an uncommitted outer transaction', () => {
    const f = fixture();
    try {
      expect(() => f.db.transaction(() => f.ledger.admit(f.pod, proof))()).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM source_publication_intents').get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  });

  it('records admission separately from immutable confirmation and deduplicates replay', () => {
    const f = fixture();
    try {
      const id = f.ledger.admit(f.pod, proof);
      expect(f.ledger.get(id)).toMatchObject({ state: 'admitted', receipt: null });
      f.ledger.confirm(f.pod, id, proof);
      const receipt = f.ledger.get(id);
      expect(receipt).toMatchObject({ state: 'confirmed', receipt: proof });
      expect(f.ledger.admit(f.pod, proof)).toBe(id);
      f.ledger.confirm(f.pod, id, { ...proof, observedAt: '2026-09-08T12:00:00Z' });
      expect(f.ledger.get(id)).toEqual(receipt);
      expect(f.db.prepare('SELECT count(*) AS n FROM source_publication_receipts').get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  });
  it('preserves logical-task publication evidence after deleting the worker pod', () => {
    const f = fixture();
    try {
      const id = f.ledger.admit(f.pod, proof);
      f.ledger.confirm(f.pod, id, proof);
      f.repo.delete(f.pod.id);
      expect(f.ledger.get(id)).toMatchObject({ state: 'confirmed', receipt: proof });
      expect(
        f.db
          .prepare(
            'SELECT i.task_id FROM source_publication_intents i JOIN logical_tasks t ON t.id = i.task_id WHERE i.id = ?',
          )
          .get(id),
      ).toBeDefined();
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it.each(['generation', 'worktree', 'branch', 'decision', 'mismatched-proof'] as const)(
    'does not confirm stale or unproven source (%s)',
    (change) => {
      const f = fixture();
      try {
        const id = f.ledger.admit(f.pod, proof);
        if (change === 'generation') f.repo.incrementLifecycleGeneration(f.pod.id);
        if (change === 'worktree') f.repo.update(f.pod.id, { worktreePath: '/tmp/replaced' });
        if (change === 'branch')
          f.db.prepare("UPDATE pods SET branch = 'replacement' WHERE id = ?").run(f.pod.id);
        if (change === 'decision') f.repo.update(f.pod.id, { status: 'awaiting_input' });
        expect(() =>
          f.ledger.confirm(
            f.pod,
            id,
            change === 'mismatched-proof'
              ? { ...proof, observedRemoteCommitSha: 'c'.repeat(40) }
              : proof,
          ),
        ).toThrow();
        expect(f.ledger.get(id)).toMatchObject({ state: 'admitted', receipt: null });
      } finally {
        f.db.close();
      }
    },
  );
});

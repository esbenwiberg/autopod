import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { type NewPod, createPodRepository } from './pod-repository.js';

const repository = 'https://github.com/org/repo';
const base = 'a'.repeat(40);
const request = (id: string): NewPod => ({
  id,
  profileName: 'test-profile',
  task: 'Implement the specified change',
  status: 'queued',
  model: 'model',
  runtime: 'codex',
  executionTarget: 'local',
  branch: id,
  userId: 'operator',
  maxValidationAttempts: 3,
  skipValidation: false,
  outputMode: 'pr',
});
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  const ledger = repo.dispatchPreflight;
  if (!ledger) throw new Error('Missing dispatch ledger');
  return { db, repo, ledger };
}

const active = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'paused',
  'validating',
  'validated',
  'review_required',
  'approved',
  'merging',
  'merge_pending',
  'killing',
] as const;
const finished = ['complete', 'failed', 'killed', 'rejected'] as const;

describe('active-only duplicate policy', () => {
  it.each(finished.flatMap((status) => [false, true].map((receipt) => ({ status, receipt }))))(
    'ignores finished $status with receipt=$receipt without rewriting its evidence',
    ({ status, receipt }) => {
      const f = fixture();
      try {
        f.repo.insert(request('prior'));
        const evidence = receipt ? f.ledger.inspect('prior', 1, repository, 'main', base) : null;
        f.db.prepare("UPDATE pods SET status=? WHERE id='prior'").run(status);
        f.repo.insert(request('next'));
        expect(f.ledger.inspect('next', 1, repository, 'main', base)).toMatchObject({
          status: 'admitted',
          conflicts: [],
        });
        if (evidence)
          expect(
            f.db
              .prepare('SELECT work_hash FROM execution_dispatch_preflights WHERE id=?')
              .get(evidence.id),
          ).toEqual({ work_hash: evidence.workHash });
      } finally {
        f.db.close();
      }
    },
  );
  it.each(active.flatMap((status) => [false, true].map((receipt) => ({ status, receipt }))))(
    'blocks active $status with receipt=$receipt',
    ({ status, receipt }) => {
      const f = fixture();
      try {
        f.repo.insert(request('prior'));
        if (receipt) f.ledger.inspect('prior', 1, repository, 'main', base);
        f.db.prepare("UPDATE pods SET status=? WHERE id='prior'").run(status);
        f.repo.insert(request('next'));
        expect(f.ledger.inspect('next', 1, repository, 'main', base)).toMatchObject({
          status: 'review_required',
          conflicts: [{ podId: 'prior' }],
        });
      } finally {
        f.db.close();
      }
    },
  );
  it('excludes deleted history before applying the active conflict bound', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 102; i++) {
        const id = `old-${i}`;
        f.repo.insert(request(id));
        f.ledger.inspect(id, 1, repository, 'main', base);
        f.repo.delete(id);
      }
      f.repo.insert(request('next'));
      expect(f.ledger.inspect('next', 1, repository, 'main', base)).toMatchObject({
        status: 'admitted',
        conflicts: [],
      });
      expect(
        f.db.prepare('SELECT COUNT(*) AS count FROM execution_dispatch_preflights').get(),
      ).toEqual({ count: 103 });
    } finally {
      f.db.close();
    }
  });
});

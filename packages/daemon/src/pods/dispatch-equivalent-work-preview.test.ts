import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { equivalentWorkFixes } from './dispatch-preflight-ledger.js';
import { createPodRepository, type NewPod } from './pod-repository.js';

const repository = 'https://github.com/org/repo';
const base = 'a'.repeat(40);
const task = 'Implement the specified change';
const request = (id: string, changes: Partial<NewPod> = {}): NewPod => ({
  id,
  profileName: 'test-profile',
  task,
  status: 'queued',
  model: 'model',
  runtime: 'codex',
  executionTarget: 'local',
  branch: id,
  userId: 'operator',
  maxValidationAttempts: 3,
  skipValidation: false,
  outputMode: 'pr',
  ...changes,
});
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  const ledger = repo.dispatchPreflight;
  if (!ledger) throw new Error('Missing dispatch ledger');
  return { db, repo, ledger };
}
const receipts = (db: ReturnType<typeof createTestDb>) =>
  (db.prepare('SELECT count(*) AS n FROM execution_dispatch_preflights').get() as { n: number }).n;

/** Paused after a provider failure, before producing any code (issue #647 pod A). */
function pausedUnproductivePrior(f: ReturnType<typeof fixture>) {
  f.repo.insert(request('prior'));
  expect(f.ledger.inspect('prior', 1, repository, 'main', base).status).toBe('admitted');
  f.db
    .prepare("UPDATE pods SET status='paused', pause_reason='provider_limit' WHERE id='prior'")
    .run();
}

describe('equivalent-work assessment (#647)', () => {
  it('reports a paused pod without source changes as stale but still requires review', () => {
    const f = fixture();
    try {
      pausedUnproductivePrior(f);
      f.repo.insert(request('next'));
      const evidence = f.ledger.inspect('next', 1, repository, 'main', base);
      expect(evidence.status).toBe('review_required');
      expect(evidence.conflicts).toEqual([
        expect.objectContaining({
          podId: 'prior',
          status: 'paused',
          assessment: {
            classification: 'stale',
            reasons: expect.arrayContaining([
              'paused (provider_limit); no worker running',
              'no source changes',
              'no commits',
              'no validation',
              'no PR',
            ]),
          },
        }),
      ]);
      // Persisted receipts keep the visible assessment for `ap dispatch-preflight`.
      expect(f.ledger.latest('next')?.conflicts[0]?.assessment?.classification).toBe('stale');
    } finally {
      f.db.close();
    }
  });

  it.each([
    ['source changes', 'files_changed=2, lines_added=10'],
    ['commits', 'commit_count=1'],
    ['validation', 'validation_attempts=1'],
    ['a PR', "pr_url='https://github.com/org/repo/pull/1'"],
  ])('keeps a paused pod with %s active', (_label, assignment) => {
    const f = fixture();
    try {
      pausedUnproductivePrior(f);
      f.db.prepare(`UPDATE pods SET ${assignment} WHERE id='prior'`).run();
      f.repo.insert(request('next'));
      const evidence = f.ledger.inspect('next', 1, repository, 'main', base);
      expect(evidence.status).toBe('review_required');
      expect(evidence.conflicts[0]?.assessment?.classification).toBe('active');
    } finally {
      f.db.close();
    }
  });

  it('keeps a running pod active even without changes', () => {
    const f = fixture();
    try {
      f.repo.insert(request('prior'));
      f.ledger.inspect('prior', 1, repository, 'main', base);
      f.db.prepare("UPDATE pods SET status='running' WHERE id='prior'").run();
      f.repo.insert(request('next'));
      const evidence = f.ledger.inspect('next', 1, repository, 'main', base);
      expect(evidence.status).toBe('review_required');
      expect(evidence.conflicts[0]?.assessment).toMatchObject({
        classification: 'active',
        reasons: expect.arrayContaining(['status running']),
      });
    } finally {
      f.db.close();
    }
  });
});

describe('read-only dispatch preview (#647)', () => {
  it('reports the conflict and the direct fixes without writing evidence', () => {
    const f = fixture();
    try {
      pausedUnproductivePrior(f);
      const before = receipts(f.db);
      const preview = f.ledger.preview({
        repository: `${repository}.git`,
        baseBranch: 'main',
        task,
        contract: null,
      });
      expect(preview).toMatchObject({
        status: 'review_required',
        repository: 'github.com/org/repo',
        baseBranch: 'main',
        conflicts: [{ podId: 'prior', status: 'paused', assessment: { classification: 'stale' } }],
      });
      expect(preview.suggestedActions).toEqual([
        'Stop the existing execution if it should not continue: ap kill prior',
        'Or launch this request as an intentional rerun: ap run … --rerun-of prior --rerun-reason "<why>"',
      ]);
      expect(receipts(f.db)).toBe(before);
    } finally {
      f.db.close();
    }
  });

  it('also finds legacy requests without receipts', () => {
    const f = fixture();
    try {
      f.repo.insert(request('legacy'));
      expect(
        f.ledger.preview({ repository, baseBranch: 'main', task, contract: null }),
      ).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'legacy', evidence: 'legacy_request' }],
      });
    } finally {
      f.db.close();
    }
  });

  it('is clear for different work, base, or finished priors', () => {
    const f = fixture();
    try {
      pausedUnproductivePrior(f);
      expect(
        f.ledger.preview({ repository, baseBranch: 'main', task: 'Other work', contract: null })
          .status,
      ).toBe('clear');
      expect(
        f.ledger.preview({ repository, baseBranch: 'develop', task, contract: null }).status,
      ).toBe('clear');
      f.db.prepare("UPDATE pods SET status='killed' WHERE id='prior'").run();
      expect(f.ledger.preview({ repository, baseBranch: 'main', task, contract: null })).toEqual({
        status: 'clear',
        repository: 'github.com/org/repo',
        baseBranch: 'main',
        conflicts: [],
        suggestedActions: [],
      });
    } finally {
      f.db.close();
    }
  });

  it('matches the stored contract and authorizes a rerun naming the single conflict', () => {
    const f = fixture();
    try {
      const contract = { requiredFacts: [], doneWhen: ['tests pass'] };
      f.repo.insert(request('prior', { contract: contract as NewPod['contract'] }));
      f.ledger.inspect('prior', 1, repository, 'main', base);
      const input = { repository, baseBranch: 'main', task, contract };
      expect(f.ledger.preview(input).status).toBe('review_required');
      expect(f.ledger.preview({ ...input, contract: null }).status).toBe('clear');
      expect(f.ledger.preview({ ...input, intentionalRerun: { ofPodId: 'prior' } })).toMatchObject({
        status: 'authorized',
        suggestedActions: [],
      });
      expect(f.ledger.preview({ ...input, intentionalRerun: { ofPodId: 'other' } }).status).toBe(
        'review_required',
      );
    } finally {
      f.db.close();
    }
  });

  it('a launch as an intentional rerun of the stale pod is admitted at provisioning', () => {
    const f = fixture();
    try {
      pausedUnproductivePrior(f);
      f.repo.insert(
        request('next', {
          rerunRequestHash: 'b'.repeat(64),
          intentionalRerun: {
            ofPodId: 'prior',
            requestKey: 'relaunch-647',
            reason: 'Prior pod paused without output; relaunch with a different AI preset',
          },
        }),
      );
      expect(f.ledger.inspect('next', 1, repository, 'main', base)).toMatchObject({
        status: 'admitted',
        conflicts: [{ podId: 'prior', assessment: { classification: 'stale' } }],
        rerun: { ofPodId: 'prior' },
      });
    } finally {
      f.db.close();
    }
  });
});

describe('equivalentWorkFixes', () => {
  it('only offers the rerun shortcut for a single conflict', () => {
    const conflict = {
      podId: 'a',
      executionId: 'e',
      status: 'paused',
      evidence: 'dispatch_receipt' as const,
    };
    expect(equivalentWorkFixes([conflict, { ...conflict, podId: 'b' }])).toEqual([
      'Stop the existing execution if it should not continue: ap kill a',
      'Stop the existing execution if it should not continue: ap kill b',
    ]);
  });
});

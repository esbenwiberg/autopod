import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { DISPATCH_CANDIDATES_SQL } from './dispatch-preflight-ledger.js';
import { type NewPod, createPodRepository } from './pod-repository.js';

const base = 'a'.repeat(40);
const repository = 'https://github.com/org/repo';
const request = (id: string, changes: Partial<NewPod> = {}): NewPod => ({
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

const repairPlaceholder = '[PR FIX] Awaiting queued feedback.';
function addRepair(f: ReturnType<typeof fixture>, parent: string, child: string, number: number) {
  const prUrl = `https://github.com/org/repo/pull/${number}`;
  const branch = `repair/${number}`;
  f.repo.insert(
    request(parent, { task: `Original task ${parent}`, branch, prUrl, status: 'merge_pending' }),
  );
  f.repo.insert(request(child, { task: repairPlaceholder, branch, prUrl, linkedPodId: parent }));
  f.repo.update(parent, { fixPodId: child });
}

function recordLegacyRepair(f: ReturnType<typeof fixture>, child: string) {
  const work = createHash('sha256')
    .update(JSON.stringify({ contract: null, task: repairPlaceholder }))
    .digest('hex');
  f.db
    .prepare(`INSERT INTO execution_dispatch_preflights
    (id,execution_id,task_id,pod_id,generation,version,repository,base_branch,base_commit_sha,work_hash,status,conflicts,rerun_intent,checked_at)
    SELECT ?,e.execution_id,e.task_id,p.id,p.lifecycle_generation,1,
    'github.com/org/repo','main',?,?,'admitted','[]',NULL,?
    FROM pods p JOIN task_executions e ON e.pod_id=p.id WHERE p.id=?`)
    .run(`legacy-${child}`, base, work, new Date().toISOString(), child);
}

describe('canonical PR repair dispatch and exact rerun authorization', () => {
  it('holds a distinct repair rerun without an executable feedback handoff, without creating an orphan task', () => {
    const f = fixture();
    try {
      addRepair(f, 'prior-parent', 'prior-fix', 11);
      recordLegacyRepair(f, 'prior-fix');
      addRepair(f, 'blocked-parent', 'blocked-fix', 11);
      expect(f.ledger.inspect('blocked-fix', 1, repository, 'main', base).status).toBe(
        'review_required',
      );
      // Hash equivalence is NOT executable work: an unlinked rerun cannot drain
      // the canonical parent's feedback. Continue the existing repair instead.
      expect(() =>
        f.repo.insert(
          request('rerun', {
            task: repairPlaceholder,
            rerunRequestHash: 'b'.repeat(64),
            intentionalRerun: {
              ofPodId: 'blocked-fix',
              requestKey: 'scoped-rerun-without-feedback',
              reason:
                'Reviewed the conflicts but have not materialized an executable feedback handoff.',
            },
          }),
        ),
      ).toThrow('executable feedback');
      expect(f.db.prepare("SELECT id FROM pods WHERE id='rerun'").get()).toBeUndefined();
      expect(f.repo.getOrThrow('blocked-parent').fixPodId).toBe('blocked-fix');
    } finally {
      f.db.close();
    }
  });
  it('holds already-recorded legacy placeholder rerun intents without rewriting their audit rows', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent', 'source-fix', 11);
      f.repo.insert(request('old-rerun', { task: repairPlaceholder }));
      const work = createHash('sha256')
        .update(JSON.stringify({ contract: null, task: repairPlaceholder }))
        .digest('hex');
      f.db
        .prepare(`INSERT INTO execution_rerun_intents
        (execution_id,pod_id,source_pod_id,source_execution_id,source_repository,source_base_branch,work_hash,reason,user_id,request_key,request_hash,actor,recorded_at)
        SELECT current.execution_id,current.pod_id,source.pod_id,source.execution_id,
        'github.com/org/repo','main',?,'Historical reviewed rerun','operator','old-rerun-key',?, ?,?
        FROM task_executions current JOIN task_executions source ON source.pod_id='source-fix'
        WHERE current.pod_id='old-rerun'`)
        .run(
          work,
          'a'.repeat(64),
          JSON.stringify({ type: 'human', userId: 'operator' }),
          new Date().toISOString(),
        );
      expect(() => f.ledger.inspect('old-rerun', 1, repository, 'main', base)).toThrow(
        'executable feedback',
      );
      expect(
        f.db
          .prepare("SELECT request_key FROM execution_rerun_intents WHERE pod_id='old-rerun'")
          .get(),
      ).toEqual({ request_key: 'old-rerun-key' });
    } finally {
      f.db.close();
    }
  });
  it('authorizes only the named direct conflict, never a second unreviewed admitted rerun', () => {
    const f = fixture();
    try {
      f.repo.insert(request('source'));
      f.ledger.inspect('source', 1, repository, 'main', base);
      for (const id of ['rerun-one', 'rerun-two']) {
        f.repo.insert(
          request(id, {
            rerunRequestHash: (id === 'rerun-one' ? 'c' : 'd').repeat(64),
            intentionalRerun: {
              ofPodId: 'source',
              requestKey: id,
              reason: 'Reviewed only the named original execution.',
            },
          }),
        );
        expect(f.ledger.inspect(id, 1, repository, 'main', base).status).toBe(
          id === 'rerun-one' ? 'admitted' : 'review_required',
        );
      }
    } finally {
      f.db.close();
    }
  });
  it('does not confuse two still-queued canonical repair placeholders for different PRs', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent-a', 'fix-a', 11);
      addRepair(f, 'parent-b', 'fix-b', 12);
      expect(f.ledger.inspect('fix-b', 1, repository, 'main', base)).toMatchObject({
        status: 'admitted',
        conflicts: [],
      });
    } finally {
      f.db.close();
    }
  });
  it.each(
    (['different-pr', 'same-pr', 'missing-pr', 'foreign-pr', 'parent-mismatch'] as const).flatMap(
      (kind) => [false, true].map((deleted) => ({ kind, deleted })),
    ),
  )(
    'classifies active legacy PR receipts, ignoring deleted history: $kind / deleted=$deleted',
    ({ kind, deleted }) => {
      const f = fixture();
      try {
        addRepair(f, 'old-parent', 'old-fix', 11);
        const legacyHash = createHash('sha256')
          .update(JSON.stringify({ contract: null, task: repairPlaceholder }))
          .digest('hex');
        // Historical fixture constructed as the old binary recorded it. No receipt is updated.
        f.db
          .prepare(`INSERT INTO execution_dispatch_preflights
          (id,execution_id,task_id,pod_id,generation,version,repository,base_branch,base_commit_sha,work_hash,status,conflicts,rerun_intent,checked_at)
          SELECT 'legacy-fix',e.execution_id,e.task_id,p.id,p.lifecycle_generation,1,
          'github.com/org/repo','main',?,?,'admitted','[]',NULL,?
          FROM pods p JOIN task_executions e ON e.pod_id=p.id WHERE p.id='old-fix'`)
          .run(base, legacyHash, new Date().toISOString());
        f.repo.update('old-fix', {
          task: '[PR FIX] Expanded feedback',
          ...(kind === 'missing-pr' ? { prUrl: null } : {}),
          ...(kind === 'foreign-pr' ? { prUrl: 'https://github.com/elsewhere/repo/pull/12' } : {}),
        });
        if (kind === 'parent-mismatch') {
          f.repo.update('old-parent', { prUrl: 'https://github.com/org/repo/pull/99' });
        }
        if (deleted) f.repo.delete('old-fix');
        addRepair(f, 'new-parent', 'new-fix', kind === 'same-pr' ? 11 : 12);
        expect(f.ledger.inspect('new-fix', 1, repository, 'main', base).status).toBe(
          deleted || kind === 'different-pr' ? 'admitted' : 'review_required',
        );
        expect(
          f.db
            .prepare("SELECT work_hash FROM execution_dispatch_preflights WHERE id='legacy-fix'")
            .get(),
        ).toEqual({ work_hash: legacyHash });
      } finally {
        f.db.close();
      }
    },
  );
  it('keeps same-PR repair and ordinary-placeholder duplicate protections', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent-a', 'fix-a', 11);
      f.ledger.inspect('fix-a', 1, repository, 'main', base);
      addRepair(f, 'parent-b', 'fix-b', 11);
      f.repo.update('parent-b', { prUrl: 'https://github.com/Org/Repo/pull/11/' });
      f.repo.update('fix-b', { prUrl: 'https://github.com/Org/Repo/pull/11/' });
      expect(f.ledger.inspect('fix-b', 1, repository, 'main', base).status).toBe('review_required');
      f.repo.insert(request('literal-a', { task: repairPlaceholder }));
      f.ledger.inspect('literal-a', 1, repository, 'main', base);
      f.repo.insert(request('literal-b', { task: repairPlaceholder }));
      expect(f.ledger.inspect('literal-b', 1, repository, 'main', base).status).toBe(
        'review_required',
      );
    } finally {
      f.db.close();
    }
  });
  it('refuses stale canonical ownership or a mismatched PR/branch instead of exempting linked work', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent', 'fix', 11);
      f.repo.update('parent', { fixPodId: null });
      expect(() => f.ledger.inspect('fix', 1, repository, 'main', base)).toThrow('repair identity');
      f.repo.update('parent', { fixPodId: 'fix' });
      f.repo.update('fix', { prUrl: 'https://github.com/org/repo/pull/12' });
      expect(() => f.ledger.inspect('fix', 1, repository, 'main', base)).toThrow('repair identity');
      f.repo.update('parent', { prUrl: 'https://github.com/elsewhere/repo/pull/12' });
      f.repo.update('fix', { prUrl: 'https://github.com/elsewhere/repo/pull/12' });
      expect(() => f.ledger.inspect('fix', 1, repository, 'main', base)).toThrow('repair identity');
      f.repo.update('parent', { prUrl: 'https://github.com/org/repo/pull/11' });
      f.repo.update('fix', { prUrl: 'https://github.com/org/repo/pull/11' });
      // Corrupt local fixture construction only; branch is not an operator-editable field.
      f.db.prepare("UPDATE pods SET branch='wrong-branch' WHERE id='fix'").run();
      expect(() => f.ledger.inspect('fix', 1, repository, 'main', base)).toThrow('repair identity');
    } finally {
      f.db.close();
    }
  });
  it('uses the same single-PR series owner as fix admission, not a PR-less triggering sibling', () => {
    const f = fixture();
    try {
      const prUrl = 'https://github.com/org/repo/pull/11';
      f.repo.insert(
        request('owner', {
          task: 'Series PR owner',
          seriesId: 'series',
          prMode: 'single',
          branch: 'owner-tip',
          prUrl,
          status: 'merge_pending',
        }),
      );
      f.repo.insert(
        request('sibling', {
          task: 'Another brief in series',
          seriesId: 'series',
          prMode: 'single',
          branch: 'sibling-tip',
          baseBranch: 'sibling-base',
          status: 'merge_pending',
        }),
      );
      f.repo.insert(
        request('fix', {
          task: repairPlaceholder,
          linkedPodId: 'sibling',
          branch: 'owner-tip',
          baseBranch: 'main',
          prUrl,
        }),
      );
      f.repo.update('sibling', { fixPodId: 'fix' });
      expect(f.ledger.inspect('fix', 1, repository, 'main', base).status).toBe('admitted');
    } finally {
      f.db.close();
    }
  });
  it('keeps linked rework in its task but requires explicit review before a distinct rerun supersedes both executions', () => {
    const f = fixture();
    try {
      f.repo.insert(request('source'));
      f.ledger.inspect('source', 1, repository, 'main', base);
      f.repo.insert(request('fix', { linkedPodId: 'source' }));
      expect(f.ledger.inspect('fix', 1, repository, 'main', base).status).toBe('admitted');
      f.repo.insert(
        request('blocked-rerun', {
          rerunRequestHash: 'e'.repeat(64),
          intentionalRerun: {
            ofPodId: 'source',
            requestKey: 'source-only',
            reason: 'Reviewed the source, not its additional repair execution.',
          },
        }),
      );
      expect(f.ledger.inspect('blocked-rerun', 1, repository, 'main', base).status).toBe(
        'review_required',
      );
      f.repo.insert(
        request('reviewed-rerun', {
          rerunRequestHash: 'f'.repeat(64),
          intentionalRerun: {
            ofPodId: 'blocked-rerun',
            requestKey: 'reviewed-source-and-fix',
            reason: 'Reviewed both exact executions recorded in the blocked request.',
          },
        }),
      );
      expect(f.ledger.inspect('reviewed-rerun', 1, repository, 'main', base).status).toBe(
        'admitted',
      );
    } finally {
      f.db.close();
    }
  });
});

it.each([false, true])(
  'keeps immutable parent-first ancestry for active generic receipts, corrupt=%s',
  (corrupt) => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      recordLegacyRepair(f, 'old-fix');
      if (corrupt) f.repo.update('old-parent', { fixPodId: null });
      const receipt = f.db.prepare('SELECT * FROM execution_dispatch_preflights').all();
      f.repo.delete('old-parent');
      expect(f.repo.getOrThrow('old-fix').linkedPodId).toBeNull();
      addRepair(f, 'new-parent', 'new-fix', 12);
      expect(f.ledger.inspect('new-fix', 1, repository, 'main', base).status).toBe(
        corrupt ? 'review_required' : 'admitted',
      );
      expect(
        f.db.prepare("SELECT * FROM execution_dispatch_preflights WHERE id='legacy-old-fix'").all(),
      ).toEqual(receipt);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      f.db.close();
    }
  },
);

it.each(['base', 'repository', 'branch', 'pointer', 'series', 'missing-pr'] as const)(
  'keeps contradictory generic receipt witnesses blocking: %s',
  (kind) => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      recordLegacyRepair(f, 'old-fix');
      if (kind === 'base') f.repo.update('old-parent', { baseBranch: 'release' });
      if (kind === 'repository')
        f.db
          .prepare("UPDATE pods SET profile_snapshot=? WHERE id='old-parent'")
          .run(
            JSON.stringify({ repoUrl: 'https://github.com/foreign/repo', defaultBranch: 'main' }),
          );
      if (kind === 'repository')
        f.db
          .prepare(
            "DELETE FROM execution_dispatch_bindings WHERE execution_id=(SELECT execution_id FROM task_executions WHERE pod_id='old-parent')",
          )
          .run();
      if (kind === 'branch')
        f.db.prepare("UPDATE pods SET branch='foreign' WHERE id='old-parent'").run();
      if (kind === 'pointer') f.repo.update('old-parent', { fixPodId: null });
      if (kind === 'series')
        f.db
          .prepare("UPDATE pods SET pr_mode='single', series_id=NULL WHERE id='old-parent'")
          .run();
      if (kind === 'missing-pr') {
        f.repo.update('old-parent', { prUrl: null });
        f.repo.delete('old-parent');
      }
      addRepair(f, 'new-parent', 'new-fix', 12);
      expect(f.ledger.inspect('new-fix', 1, repository, 'main', base).status).toBe(
        'review_required',
      );
    } finally {
      f.db.close();
    }
  },
);

it.each(['missing-parent', 'missing-pr', 'base', 'series', 'foreign-repository'] as const)(
  'refuses missing or changed current repair ownership: %s',
  (kind) => {
    const f = fixture();
    try {
      addRepair(f, 'parent', 'fix', 11);
      if (kind === 'missing-parent') f.repo.delete('parent');
      if (kind === 'missing-pr') f.repo.update('parent', { prUrl: null });
      if (kind === 'base') f.repo.update('parent', { baseBranch: 'release' });
      if (kind === 'series')
        f.db.prepare("UPDATE pods SET pr_mode='single', series_id=NULL WHERE id='parent'").run();
      if (kind === 'foreign-repository') {
        f.repo.update('parent', { prUrl: 'https://github.com/foreign/repo/pull/11' });
        f.repo.update('fix', { prUrl: 'https://github.com/foreign/repo/pull/11' });
      }
      expect(() => f.ledger.inspect('fix', 1, repository, 'main', base)).toThrow('repair identity');
      expect(f.ledger.latest('fix')).toBeNull();
    } finally {
      f.db.close();
    }
  },
);

it.each([false, true])('supports equivalent ADO PR URLs, admitted receipt=%s', (admitted) => {
  const f = fixture();
  try {
    const remote = 'https://dev.azure.com/Org/Project/_git/Repo';
    f.db.prepare('UPDATE profiles SET repo_url=?').run(remote);
    addRepair(f, 'parent-a', 'fix-a', 11);
    addRepair(f, 'parent-b', 'fix-b', 11);
    for (const id of ['parent-a', 'fix-a'])
      f.repo.update(id, { prUrl: 'https://Org.visualstudio.com/Project/_git/Repo/pullrequest/11' });
    for (const id of ['parent-b', 'fix-b'])
      f.repo.update(id, { prUrl: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/11/' });
    if (admitted)
      expect(f.ledger.inspect('fix-a', 1, remote, 'main', base).status).toBe('admitted');
    expect(f.ledger.inspect('fix-b', 1, remote, 'main', base).status).toBe('review_required');
    f.repo.update('parent-b', {
      prUrl: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/12',
    });
    f.repo.update('fix-b', { prUrl: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/12' });
    expect(f.ledger.inspect('fix-b', 1, remote, 'main', base).status).toBe('admitted');
  } finally {
    f.db.close();
  }
});

it('requires an exact displayed conflict set when an old conflict has settled', () => {
  const f = fixture();
  try {
    f.repo.insert(request('first'));
    f.ledger.inspect('first', 1, repository, 'main', base);
    f.repo.insert(
      request('second', {
        intentionalRerun: { ofPodId: 'first', requestKey: 'second', reason: 'Reviewed original' },
        rerunRequestHash: 'a'.repeat(64),
      }),
    );
    f.ledger.inspect('second', 1, repository, 'main', base);
    f.repo.insert(request('blocked'));
    expect(f.ledger.inspect('blocked', 1, repository, 'main', base).conflicts).toHaveLength(2);
    f.repo.update('second', { status: 'complete' });
    f.repo.insert(
      request('rerun', {
        intentionalRerun: {
          ofPodId: 'blocked',
          requestKey: 'rerun',
          reason: 'Reviewed old displayed set',
        },
        rerunRequestHash: 'b'.repeat(64),
      }),
    );
    expect(f.ledger.inspect('rerun', 1, repository, 'main', base).status).toBe('review_required');
  } finally {
    f.db.close();
  }
});

it('bounds receipt candidates before reading retained history without UNION-view materialization', () => {
  const f = fixture();
  try {
    const plan = f.db
      .prepare(`EXPLAIN QUERY PLAN ${DISPATCH_CANDIDATES_SQL}`)
      .all('github.com/org/repo', 'main', 'a'.repeat(64), 'b'.repeat(64), 'task') as Array<{
      detail: string;
    }>;
    const detail = plan.map((p) => p.detail).join('\n');
    expect(detail).toContain('execution_preflight_identity');
    expect(detail).not.toMatch(/MATERIALIZE|SCAN task_history/);
  } finally {
    f.db.close();
  }
});

it('bounds active receipt candidates while leaving large deleted history untouched', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 105; i++) {
      addRepair(f, `parent-${i}`, `fix-${i}`, i + 1);
      recordLegacyRepair(f, `fix-${i}`);
      f.repo.delete(`parent-${i}`);
      f.repo.delete(`fix-${i}`);
    }
    addRepair(f, 'current-parent', 'current-fix', 200);
    expect(f.ledger.inspect('current-fix', 1, repository, 'main', base).status).toBe('admitted');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM execution_dispatch_preflights').get()).toEqual({
      n: 106,
    });
    // Construct independent historical admissions; never mutate existing receipts.
    for (let i = 0; i < 101; i++) {
      addRepair(f, `active-parent-${i}`, `active-fix-${i}`, i + 1);
      recordLegacyRepair(f, `active-fix-${i}`);
    }
    addRepair(f, 'bounded-parent', 'bounded-fix', 300);
    expect(() => f.ledger.inspect('bounded-fix', 1, repository, 'main', base)).toThrow(
      'exceeds 100 receipts',
    );
    expect(f.ledger.latest('bounded-fix')).toBeNull();
  } finally {
    f.db.close();
  }
});

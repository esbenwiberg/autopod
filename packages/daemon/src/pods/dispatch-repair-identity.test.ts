import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import {
  DISPATCH_CANDIDATES_SQL,
  GENERIC_REPAIR_CANDIDATES_SQL,
} from './dispatch-preflight-ledger.js';
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
  const inspect = (id: string) => ledger.inspect(id, 1, repository, 'main', base);
  return { db, repo, ledger, inspect };
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
  return work;
}

describe('canonical PR repair dispatch and exact rerun authorization', () => {
  it('bounds ambiguous active hashes without imposing the reverse probe on verified PRs or finished history', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 101; i++) {
        addRepair(f, `parent-${i}`, `fix-${i}`, i + 1);
        expect(f.inspect(`fix-${i}`).status).toBe('admitted');
      }
      f.repo.insert(request('literal', { task: repairPlaceholder }));
      expect(() => f.inspect('literal')).toThrow('100 active receipts');
      expect(f.ledger.latest('literal')).toBeNull();
      // Terminal and deleted receipts remain immutable, but cannot consume the
      // live ambiguity bound or veto this ordinary request.
      f.db.prepare("UPDATE pods SET status='complete' WHERE id LIKE 'fix-%'").run();
      f.repo.delete('fix-0');
      expect(f.inspect('literal')).toMatchObject({ status: 'admitted', conflicts: [] });
      expect(
        f.db.prepare('SELECT COUNT(*) AS count FROM execution_dispatch_preflights').get(),
      ).toEqual({ count: 102 });
    } finally {
      f.db.close();
    }
  });
  it('uses live execution-index receipt lookups for unknown placeholder scope', () => {
    const f = fixture();
    try {
      const plan = f.db
        .prepare(`EXPLAIN QUERY PLAN ${GENERIC_REPAIR_CANDIDATES_SQL}`)
        .all('github.com/org/repo', 'main', 'task') as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toContain('execution_preflight_execution (execution_id=?)');
      expect(detail).not.toMatch(/SCAN d\b|task_history|MATERIALIZE/i);
    } finally {
      f.db.close();
    }
  });
  it.each(['generic-first', 'repair-first'])(
    'blocks unknown placeholder ownership in %s admission order',
    (order) => {
      const f = fixture();
      try {
        const generic = () => f.repo.insert(request('literal', { task: repairPlaceholder }));
        const repair = () => addRepair(f, 'parent', 'fix', 11);
        (order === 'generic-first' ? generic : repair)();
        const first = order === 'generic-first' ? 'literal' : 'fix';
        const second = order === 'generic-first' ? 'fix' : 'literal';
        const receipt = f.inspect(first);
        expect(receipt.status).toBe('admitted');
        const original = f.db
          .prepare('SELECT * FROM execution_dispatch_preflights WHERE id=?')
          .get(receipt.id);
        (order === 'generic-first' ? repair : generic)();
        expect(f.inspect(second)).toMatchObject({
          status: 'review_required',
          conflicts: [{ podId: first, evidence: 'dispatch_receipt' }],
        });
        expect(
          f.db.prepare('SELECT * FROM execution_dispatch_preflights WHERE id=?').get(receipt.id),
        ).toEqual(original);
      } finally {
        f.db.close();
      }
    },
  );
  it.each(['expanded-and-readmitted', 'missing-pr', 'deleted-parent', 'changed-contract'])(
    'retains scoped evidence after %s',
    (change) => {
      const f = fixture();
      try {
        addRepair(f, 'parent', 'fix', 11);
        expect(f.inspect('fix').status).toBe('admitted');
        if (change === 'expanded-and-readmitted') {
          f.repo.update('fix', { task: '[PR FIX] Actual executable feedback' });
          expect(f.inspect('fix').status).toBe('admitted');
        }
        if (change === 'missing-pr') f.repo.update('fix', { prUrl: null });
        if (change === 'deleted-parent') f.repo.delete('parent');
        if (change === 'changed-contract')
          f.repo.update('fix', {
            contract: {
              contractVersion: 1,
              title: 'Changed',
              dependsOn: [],
              scenarios: [],
              requiredFacts: [],
              humanReview: [],
            },
          });
        f.repo.insert(request('literal', { task: repairPlaceholder }));
        expect(f.inspect('literal')).toMatchObject({
          status: 'review_required',
          conflicts: [{ podId: 'fix', evidence: 'dispatch_receipt' }],
        });
      } finally {
        f.db.close();
      }
    },
  );
  it.each(['complete', 'failed', 'killed', 'rejected', 'deleted'])(
    'does not block a generic placeholder with %s scoped work',
    (status) => {
      const f = fixture();
      try {
        addRepair(f, 'parent', 'fix', 11);
        const receipt = f.inspect('fix');
        if (status === 'deleted') f.repo.delete('fix');
        else f.db.prepare("UPDATE pods SET status=? WHERE id='fix'").run(status);
        f.repo.insert(request('literal', { task: repairPlaceholder }));
        expect(f.inspect('literal')).toMatchObject({ status: 'admitted', conflicts: [] });
        expect(
          f.db
            .prepare('SELECT work_hash FROM execution_dispatch_preflights WHERE id=?')
            .get(receipt.id),
        ).toEqual({ work_hash: receipt.workHash });
      } finally {
        f.db.close();
      }
    },
  );
  it.each(['ordinary', 'different-contract', 'different-base', 'different-repository'])(
    'excludes positively distinct %s work from the reverse probe',
    (kind) => {
      const f = fixture();
      try {
        addRepair(f, 'parent', 'fix', 11);
        if (kind === 'ordinary') f.repo.update('fix', { task: 'Unrelated executable work' });
        if (kind === 'different-contract')
          f.repo.update('fix', {
            contract: {
              contractVersion: 1,
              title: 'Distinct contract',
              dependsOn: [],
              scenarios: [],
              requiredFacts: [],
              humanReview: [],
            },
          });
        expect(f.inspect('fix').status).toBe('admitted');
        if (kind === 'different-repository')
          f.db
            .prepare(
              "UPDATE profiles SET repo_url='https://github.com/org/other' WHERE name='test-profile'",
            )
            .run();
        f.repo.insert(
          request('literal', {
            task: repairPlaceholder,
            ...(kind === 'different-base' ? { baseBranch: 'release' } : {}),
          }),
        );
        expect(
          f.ledger.inspect(
            'literal',
            1,
            kind === 'different-repository' ? 'https://github.com/org/other' : repository,
            kind === 'different-base' ? 'release' : 'main',
            base,
          ),
        ).toMatchObject({ status: 'admitted', conflicts: [] });
      } finally {
        f.db.close();
      }
    },
  );
  it('rejects placeholder reruns atomically without an executable handoff', () => {
    const f = fixture();
    try {
      addRepair(f, 'prior-parent', 'prior-fix', 11);
      recordLegacyRepair(f, 'prior-fix');
      addRepair(f, 'blocked-parent', 'blocked-fix', 11);
      expect(f.inspect('blocked-fix').status).toBe('review_required');
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
  it('rejects historical placeholder reruns without rewriting intents', () => {
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
      expect(() => f.inspect('old-rerun')).toThrow('executable feedback');
      expect(
        f.db
          .prepare("SELECT request_key FROM execution_rerun_intents WHERE pod_id='old-rerun'")
          .get(),
      ).toEqual({ request_key: 'old-rerun-key' });
    } finally {
      f.db.close();
    }
  });
  it('authorizes only the named direct conflict', () => {
    const f = fixture();
    try {
      f.repo.insert(request('source'));
      f.inspect('source');
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
        expect(f.inspect(id).status).toBe(id === 'rerun-one' ? 'admitted' : 'review_required');
      }
    } finally {
      f.db.close();
    }
  });
  it('separates unrelated queued PR repair placeholders', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent-a', 'fix-a', 11);
      addRepair(f, 'parent-b', 'fix-b', 12);
      expect(f.inspect('fix-b')).toMatchObject({
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
  )('classifies generic receipts: $kind / deleted=$deleted', ({ kind, deleted }) => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      const legacyHash = recordLegacyRepair(f, 'old-fix');
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
      expect(f.inspect('new-fix').status).toBe(
        deleted || kind === 'different-pr' ? 'admitted' : 'review_required',
      );
      expect(
        f.db
          .prepare("SELECT work_hash FROM execution_dispatch_preflights WHERE id='legacy-old-fix'")
          .get(),
      ).toEqual({ work_hash: legacyHash });
    } finally {
      f.db.close();
    }
  });
  it('blocks same-PR and ordinary-placeholder duplicates', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent-a', 'fix-a', 11);
      f.inspect('fix-a');
      addRepair(f, 'parent-b', 'fix-b', 11);
      f.repo.update('parent-b', { prUrl: 'https://github.com/Org/Repo/pull/11/' });
      f.repo.update('fix-b', { prUrl: 'https://github.com/Org/Repo/pull/11/' });
      expect(f.inspect('fix-b').status).toBe('review_required');
      f.repo.insert(request('literal-a', { task: repairPlaceholder }));
      f.inspect('literal-a');
      f.repo.insert(request('literal-b', { task: repairPlaceholder }));
      expect(f.inspect('literal-b').status).toBe('review_required');
    } finally {
      f.db.close();
    }
  });
  it('refuses stale ownership and mismatched PR/branch', () => {
    const f = fixture();
    try {
      addRepair(f, 'parent', 'fix', 11);
      f.repo.update('parent', { fixPodId: null });
      expect(() => f.inspect('fix')).toThrow('repair identity');
      f.repo.update('parent', { fixPodId: 'fix' });
      f.repo.update('fix', { prUrl: 'https://github.com/org/repo/pull/12' });
      expect(() => f.inspect('fix')).toThrow('repair identity');
      f.repo.update('parent', { prUrl: 'https://github.com/elsewhere/repo/pull/12' });
      f.repo.update('fix', { prUrl: 'https://github.com/elsewhere/repo/pull/12' });
      expect(() => f.inspect('fix')).toThrow('repair identity');
      f.repo.update('parent', { prUrl: 'https://github.com/org/repo/pull/11' });
      f.repo.update('fix', { prUrl: 'https://github.com/org/repo/pull/11' });
      // Corrupt local fixture construction only; branch is not an operator-editable field.
      f.db.prepare("UPDATE pods SET branch='wrong-branch' WHERE id='fix'").run();
      expect(() => f.inspect('fix')).toThrow('repair identity');
    } finally {
      f.db.close();
    }
  });
  it('shares single-PR owner selection with fix admission', () => {
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
      expect(f.inspect('fix').status).toBe('admitted');
    } finally {
      f.db.close();
    }
  });
  it('requires a rerun grant covering both source and linked rework', () => {
    const f = fixture();
    try {
      f.repo.insert(request('source'));
      f.inspect('source');
      f.repo.insert(request('fix', { linkedPodId: 'source' }));
      expect(f.inspect('fix').status).toBe('admitted');
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
      expect(f.inspect('blocked-rerun').status).toBe('review_required');
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
      expect(f.inspect('reviewed-rerun').status).toBe('admitted');
    } finally {
      f.db.close();
    }
  });
});

it.each([false, true])('preserves immutable parent-first ancestry, corrupt=%s', (corrupt) => {
  const f = fixture();
  try {
    addRepair(f, 'old-parent', 'old-fix', 11);
    recordLegacyRepair(f, 'old-fix');
    if (corrupt) f.repo.update('old-parent', { fixPodId: null });
    const receipt = f.db.prepare('SELECT * FROM execution_dispatch_preflights').all();
    f.repo.delete('old-parent');
    expect(f.repo.getOrThrow('old-fix').linkedPodId).toBeNull();
    // Normal deletion copies the parent BEFORE live FK cleanup. A missing
    // reverse claim in the archive is pre-existing corruption, not cleanup.
    expect(
      f.db.prepare("SELECT fix_pod_id FROM task_history_pods WHERE id='old-parent'").get(),
    ).toEqual({ fix_pod_id: corrupt ? null : 'old-fix' });
    expect(
      f.db.prepare("SELECT parent_pod_id FROM task_executions WHERE pod_id='old-fix'").get(),
    ).toEqual({ parent_pod_id: 'old-parent' });
    addRepair(f, 'new-parent', 'new-fix', 12);
    expect(f.inspect('new-fix').status).toBe(corrupt ? 'review_required' : 'admitted');
    expect(
      f.db.prepare("SELECT * FROM execution_dispatch_preflights WHERE id='legacy-old-fix'").all(),
    ).toEqual(receipt);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    f.db.close();
  }
});

it.each(['base', 'repository', 'branch', 'pointer', 'series', 'missing-pr'] as const)(
  'blocks contradictory generic witnesses: %s',
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
      expect(f.inspect('new-fix').status).toBe('review_required');
    } finally {
      f.db.close();
    }
  },
);

it.each(['missing-parent', 'missing-pr', 'base', 'series', 'foreign-repository'] as const)(
  'refuses missing/changed repair ownership: %s',
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
      expect(() => f.inspect('fix')).toThrow('repair identity');
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

it('rejects a changed displayed conflict set', () => {
  const f = fixture();
  try {
    f.repo.insert(request('first'));
    f.inspect('first');
    f.repo.insert(
      request('second', {
        intentionalRerun: { ofPodId: 'first', requestKey: 'second', reason: 'Reviewed original' },
        rerunRequestHash: 'a'.repeat(64),
      }),
    );
    f.inspect('second');
    f.repo.insert(request('blocked'));
    expect(f.inspect('blocked').conflicts).toHaveLength(2);
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
    expect(f.inspect('rerun').status).toBe('review_required');
  } finally {
    f.db.close();
  }
});

it('uses indexed candidates without history materialization', () => {
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

it('bounds active candidates independently of deleted history', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 105; i++) {
      addRepair(f, `parent-${i}`, `fix-${i}`, i + 1);
      recordLegacyRepair(f, `fix-${i}`);
      f.repo.delete(`parent-${i}`);
      f.repo.delete(`fix-${i}`);
    }
    addRepair(f, 'current-parent', 'current-fix', 200);
    expect(f.inspect('current-fix').status).toBe('admitted');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM execution_dispatch_preflights').get()).toEqual({
      n: 106,
    });
    // Construct independent historical admissions; never mutate existing receipts.
    for (let i = 0; i < 101; i++) {
      addRepair(f, `active-parent-${i}`, `active-fix-${i}`, i + 1);
      recordLegacyRepair(f, `active-fix-${i}`);
    }
    addRepair(f, 'bounded-parent', 'bounded-fix', 300);
    expect(() => f.inspect('bounded-fix')).toThrow('exceeds 100 receipts');
    expect(f.ledger.latest('bounded-fix')).toBeNull();
  } finally {
    f.db.close();
  }
});

it.each(['series_id', 'pr_mode'] as const)(
  'refuses contradictory current child %s metadata',
  (column) => {
    const f = fixture();
    try {
      addRepair(f, 'parent', 'fix', 11);
      f.db.prepare(`UPDATE pods SET ${column}='foreign' WHERE id='fix'`).run();
      expect(() => f.inspect('fix')).toThrow('repair identity');
      expect(f.ledger.latest('fix')).toBeNull();
    } finally {
      f.db.close();
    }
  },
);

it.each(['series_id', 'pr_mode'] as const)(
  'blocks generic receipts with contradictory child %s',
  (column) => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      recordLegacyRepair(f, 'old-fix');
      const receipt = f.db.prepare('SELECT * FROM execution_dispatch_preflights').all();
      f.db.prepare(`UPDATE pods SET ${column}='foreign' WHERE id='old-fix'`).run();
      f.repo.delete('old-parent');
      addRepair(f, 'new-parent', 'new-fix', 12);
      expect(f.inspect('new-fix').status).toBe('review_required');
      expect(
        f.db.prepare("SELECT * FROM execution_dispatch_preflights WHERE id='legacy-old-fix'").all(),
      ).toEqual(receipt);
    } finally {
      f.db.close();
    }
  },
);

it('supports matching and absent child series metadata', () => {
  const f = fixture();
  try {
    addRepair(f, 'parent', 'fix', 11);
    f.db
      .prepare("UPDATE pods SET series_id='series', pr_mode='single' WHERE id IN ('parent','fix')")
      .run();
    expect(f.inspect('fix').status).toBe('admitted');
    f.db.prepare("UPDATE pods SET series_id=NULL, pr_mode=NULL WHERE id='fix'").run();
    expect(f.inspect('fix').status).toBe('admitted');
  } finally {
    f.db.close();
  }
});

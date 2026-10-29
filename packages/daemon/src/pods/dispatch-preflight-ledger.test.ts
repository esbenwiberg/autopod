import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations, runMigrationsWithBackups } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
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

describe('dispatch admission against immutable execution evidence', () => {
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
  it('uses immutable execution parent lineage after normal parent-first deletion clears the child pointer', () => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      recordLegacyRepair(f, 'old-fix');
      f.repo.delete('old-parent');
      expect(f.repo.getOrThrow('old-fix').linkedPodId).toBeNull();
      f.repo.delete('old-fix');
      addRepair(f, 'new-parent', 'new-fix', 12);
      expect(f.ledger.inspect('new-fix', 1, repository, 'main', base).status).toBe('admitted');
    } finally {
      f.db.close();
    }
  });
  it('bounds receipt candidates before reading retained history without UNION-view materialization', () => {
    const f = fixture();
    try {
      const plan = f.db
        .prepare(`EXPLAIN QUERY PLAN ${DISPATCH_CANDIDATES_SQL}`)
        .all(
          'github.com/org/repo',
          'main',
          'a'.repeat(64),
          'b'.repeat(64),
          'task',
          new Date().toISOString(),
        ) as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join('\n');
      expect(detail).toContain('execution_preflight_identity');
      expect(detail).not.toMatch(/MATERIALIZE|SCAN task_history/);
    } finally {
      f.db.close();
    }
  });
  it('distinguishes canonical queued repairs of different PRs, including deleted old repairs', () => {
    const f = fixture();
    try {
      addRepair(f, 'old-parent', 'old-fix', 11);
      const prior = f.ledger.inspect('old-fix', 1, repository, 'main', base);
      expect(prior.status).toBe('admitted');
      // As in production, the running repair replaces its placeholder with feedback.
      f.repo.update('old-fix', { task: '[PR FIX] Expanded feedback for PR11' });
      f.repo.delete('old-fix');
      addRepair(f, 'new-parent', 'new-fix', 12);
      expect(f.ledger.inspect('new-fix', 1, repository, 'main', base)).toMatchObject({
        status: 'admitted',
        conflicts: [],
      });
      expect(
        f.db
          .prepare('SELECT work_hash FROM execution_dispatch_preflights WHERE id=?')
          .get(prior.id),
      ).toEqual({ work_hash: prior.workHash });
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
  it.each(['different-pr', 'same-pr', 'missing-pr', 'foreign-pr', 'parent-mismatch'] as const)(
    'classifies immutable pre-fix placeholder receipts without guessing missing history: %s',
    (kind) => {
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
        f.repo.delete('old-fix');
        addRepair(f, 'new-parent', 'new-fix', kind === 'same-pr' ? 11 : 12);
        expect(f.ledger.inspect('new-fix', 1, repository, 'main', base).status).toBe(
          kind === 'different-pr' ? 'admitted' : 'review_required',
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
  it('serializes equivalent queued work and requires an audited distinct rerun', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      repo.insert(request('second'));
      expect(ledger.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'first', evidence: 'legacy_request' }],
      });
      const first = ledger.inspect('first', 1, repository, 'main', base);
      expect(first.status).toBe('admitted');
      repo.insert(
        request('rerun', {
          rerunRequestHash: 'a'.repeat(64),
          intentionalRerun: {
            requestKey: 'explicit-rerun-1',
            ofPodId: 'first',
            reason: 'Repeat after requirements review',
          },
        }),
      );
      const rerun = ledger.inspect('rerun', 1, repository, 'main', base);
      expect(rerun).toMatchObject({
        status: 'admitted',
        rerun: { ofPodId: 'first', actor: { type: 'human', userId: 'operator' } },
      });
      expect(rerun.executionId).not.toBe(first.executionId);
      expect(rerun.taskId).not.toBe(first.taskId);
      expect(() =>
        db.prepare("UPDATE execution_rerun_intents SET reason = 'changed'").run(),
      ).toThrow('immutable');
      expect(() =>
        db.prepare("UPDATE execution_dispatch_preflights SET status = 'admitted'").run(),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('retains evidence across disk restart and deletion without attributing it to a missing current execution', () => {
    const f = fixture();
    f.repo.insert(request('first'));
    const first = f.ledger.inspect('first', 1, repository, 'main', base);
    f.repo.insert(request('second'));
    f.repo.delete('first');
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-restart-'));
    writeFileSync(join(dir, 'state.db'), f.db.serialize());
    f.db.close();
    const db = new Database(join(dir, 'state.db'));
    try {
      const ledger = createPodRepository(db).dispatchPreflight;
      expect(ledger?.latest('first')).toBeNull();
      expect(ledger?.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [
          { executionId: first.executionId, status: 'deleted', evidence: 'dispatch_receipt' },
        ],
      });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('freezes queued repository and base, rejects drift, and keeps independent repositories distinct', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      db.prepare(
        "UPDATE profiles SET repo_url = 'https://github.com/elsewhere/repo', default_branch = 'next'",
      ).run();
      expect(() =>
        ledger.inspect('first', 1, 'https://github.com/elsewhere/repo', 'next', base),
      ).toThrow('binding changed');
      expect(ledger.inspect('first', 1, repository, 'main', base).status).toBe('admitted');
      repo.insert(request('independent'));
      expect(
        ledger.inspect('independent', 1, 'https://github.com/elsewhere/repo', 'next', base).status,
      ).toBe('admitted');
      expect(() =>
        repo.insert(
          request('invalid', {
            rerunRequestHash: 'a'.repeat(64),
            intentionalRerun: { requestKey: 'explicit-rerun-1', ofPodId: 'first', reason: '' },
          }),
        ),
      ).toThrow('human reason');
      expect(() => repo.getOrThrow('invalid')).toThrow('not found');
      expect(
        db.prepare("SELECT * FROM logical_tasks WHERE root_pod_id = 'invalid'").get(),
      ).toBeUndefined();
      expect(() => ledger.inspect('first', 2, repository, 'main', base)).toThrow('Stale');
      expect(() => ledger.inspect('first', 1, repository, 'main', 'a'.repeat(41))).toThrow(
        'SHA unavailable',
      );
    } finally {
      db.close();
    }
  });
  it('does not accept malformed legacy contracts or an unknown historical repository as current evidence', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      repo.insert(request('second'));
      db.prepare(
        "DELETE FROM execution_dispatch_bindings WHERE execution_id = (SELECT execution_id FROM task_executions WHERE pod_id = 'first')",
      ).run();
      db.prepare(
        "UPDATE pods SET base_branch = 'main', profile_snapshot = NULL WHERE id = 'first'",
      ).run();
      expect(() => ledger.inspect('second', 1, repository, 'main', base)).toThrow(
        'Historical repository binding',
      );
      db.prepare(
        "UPDATE pods SET profile_snapshot = ?, contract = 'bad-json' WHERE id = 'first'",
      ).run(JSON.stringify({ repoUrl: repository }));
      expect(() => ledger.inspect('second', 1, repository, 'main', base)).toThrow(
        'contract is unreadable',
      );
      expect(ledger.latest('second')).toBeNull();
    } finally {
      db.close();
    }
  });
  it('admits a rerun of the blocked request for exactly the conflicts it recorded', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      expect(ledger.inspect('first', 1, repository, 'main', base).status).toBe('admitted');
      repo.insert(request('blocked'));
      expect(ledger.inspect('blocked', 1, repository, 'main', base).status).toBe('review_required');
      // The desktop/CLI rerun of a failed pod names that pod, not the conflict it was shown.
      const rerun = (id: string, requestKey: string) =>
        repo.insert(
          request(id, {
            rerunRequestHash: 'a'.repeat(64),
            intentionalRerun: { requestKey, ofPodId: 'blocked', reason: 'Prior run was killed' },
          }),
        );
      rerun('rerun', 'rerun-1');
      expect(ledger.inspect('rerun', 1, repository, 'main', base)).toMatchObject({
        status: 'admitted',
        rerun: { ofPodId: 'blocked' },
      });
      // The admitted rerun is new equivalent work the human never reviewed.
      rerun('again', 'rerun-2');
      expect(ledger.inspect('again', 1, repository, 'main', base).status).toBe('review_required');
    } finally {
      db.close();
    }
  });
  it('lets a schedule repeat its finished or deleted runs but never overlap an active one', () => {
    const { db, repo, ledger } = fixture();
    try {
      db.prepare(
        "INSERT INTO scheduled_jobs (id,name,profile_name,task,cron_expression,next_run_at) VALUES ('job','Daily','test-profile','t','0 10 * * *','2030-01-01T00:00:00Z')",
      ).run();
      const run = (id: string) => repo.insert(request(id, { scheduledJobId: 'job' }));
      const inspect = (id: string) => ledger.inspect(id, 1, repository, 'main', base);
      run('monday');
      expect(inspect('monday').status).toBe('admitted');
      run('overlap');
      expect(inspect('overlap')).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'monday' }],
      });
      db.prepare("UPDATE pods SET status = 'complete' WHERE id = 'monday'").run();
      run('tuesday');
      expect(inspect('tuesday').status).toBe('admitted');
      db.prepare("UPDATE pods SET status = 'killed' WHERE id = 'tuesday'").run();
      repo.delete('tuesday');
      run('wednesday');
      expect(inspect('wednesday').status).toBe('admitted');
      // Identical work from outside the schedule is still a duplicate of the schedule's runs.
      db.prepare("UPDATE pods SET status = 'complete' WHERE id = 'wednesday'").run();
      repo.insert(request('manual'));
      expect(inspect('manual')).toMatchObject({
        status: 'review_required',
        conflicts: expect.arrayContaining([expect.objectContaining({ podId: 'wednesday' })]),
      });
    } finally {
      db.close();
    }
  });
  it('ignores terminal work outside the seven-day window but retains older active work', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first', { status: 'complete' }));
      db.prepare("UPDATE pods SET created_at = '2020-01-01T00:00:00Z' WHERE id = 'first'").run();
      repo.insert(request('second'));
      expect(ledger.inspect('second', 1, repository, 'main', base).status).toBe('admitted');
      db.prepare("UPDATE pods SET status = 'running' WHERE id = 'first'").run();
      expect(ledger.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'first' }],
      });
    } finally {
      db.close();
    }
  });
});

it.each([139, 156])('upgrades schema %s and preserves unknown legacy evidence', async (version) => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= version) copyFileSync(join(migrations, file), join(dir, file));
  const db = new Database(join(dir, 'state.db'));
  db.pragma('foreign_keys = ON');
  try {
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods (id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('old','test-profile','old','failed','model','codex','branch','operator','malformed-preserve')",
    ).run();
    await runMigrationsWithBackups(db, migrations, logger);
    expect(createPodRepository(db).dispatchPreflight?.latest('old')).toBeNull();
    expect(db.prepare("SELECT task_summary FROM pods WHERE id = 'old'").get()).toEqual({
      task_summary: 'malformed-preserve',
    });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

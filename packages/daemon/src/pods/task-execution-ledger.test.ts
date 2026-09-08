import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { aggregateCost } from './cost-aggregation.js';
import { createPodRepository } from './pod-repository.js';

function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  if (!repo.taskExecutions) throw new Error('Missing task ledger');
  for (const [id, parent] of [
    ['root', null],
    ['fix', 'root'],
    ['rerun', null],
  ] as const) {
    repo.insert({
      id,
      profileName: 'test-profile',
      task: 'Same requested work',
      status: 'running',
      model: 'model',
      runtime: 'codex',
      executionTarget: 'local',
      branch: id,
      userId: 'user',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
      linkedPodId: parent,
      tokenBudget: parent ? null : 100,
    });
  }
  return { db, repo };
}
const binding = { runtime: 'codex', model: 'model', providerAccountId: 'account' };

describe('task-wide execution accounting', () => {
  it('records immutable container ownership instead of inferring it from the current pod', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { containerId: 'original-container', tokenBudget: null });
      const resource = { containerId: 'original-container', executionTarget: 'local' as const };
      const id = repo.taskExecutions?.beginRun('root', 1, 1, { ...binding, resource });
      repo.update('root', { containerId: 'replacement-container' });
      const row = db.prepare('SELECT binding FROM task_agent_runs WHERE id = ?').get(id) as {
        binding: string;
      };
      expect(JSON.parse(row.binding)).toMatchObject({ version: 2, resource });
      expect(() =>
        repo.taskExecutions?.beginRun('root', 1, 1, {
          ...binding,
          resource: { containerId: 'replacement-container', executionTarget: 'local' },
        }),
      ).toThrow(/binding/i);
    } finally {
      db.close();
    }
  });

  it('rejects a resource identity that does not own the current lifecycle before creating a run', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { containerId: 'current-container', tokenBudget: null });
      expect(() =>
        repo.taskExecutions?.beginRun('root', 1, 1, {
          ...binding,
          resource: { containerId: 'stale-container', executionTarget: 'local' },
        }),
      ).toThrow(/resource.*binding/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM task_agent_runs').get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    JSON.stringify(binding),
    'unreadable legacy binding',
    ' '.repeat(16385),
    JSON.stringify({
      ...binding,
      version: 99,
      resource: { containerId: 'old', executionTarget: 'local' },
    }),
    JSON.stringify({
      ...binding,
      version: 2,
      resource: { containerId: null, executionTarget: 'local' },
    }),
    JSON.stringify({
      ...binding,
      version: 2,
      resource: { containerId: 'old\u001b', executionTarget: 'local' },
    }),
  ])('keeps historical resource ownership unavailable for unverified binding %#', (raw) => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { containerId: 'current-replacement' });
      db.prepare(
        "INSERT INTO task_agent_runs(id,pod_id,generation,cycle,binding,started_at) VALUES ('old','root',1,1,?,'2026-09-07T00:00:00Z')",
      ).run(raw);
      const diagnostics = repo.taskExecutions?.snapshot('fix').diagnostics.join('\n');
      expect(diagnostics).toContain(
        '1 unsettled worker run blocks another task run; live execution state unverified.',
      );
      expect(diagnostics).toContain('Oldest unsettled run resource ownership unavailable');
      expect(diagnostics).not.toContain('current-replacement');
      expect(db.prepare("SELECT binding FROM task_agent_runs WHERE id = 'old'").get()).toEqual({
        binding: raw,
      });
      expect(() => repo.taskExecutions?.beginRun('fix', 1, 1, binding)).toThrow(/still active/);
    } finally {
      db.close();
    }
  });

  it('projects latest recorded PR dispositions across linked pods without inflating receipts or parsing legacy bodies', () => {
    const { db, repo } = fixture();
    try {
      const ledger = repo.deliveryLedger;
      if (!ledger) throw new Error('Missing delivery ledger');
      const insert = (podId: string, id: string, disposition: string | null) => {
        const taskId = repo.taskExecutions?.snapshot(podId).taskId;
        const url = `https://github.com/org/repo/pull/${id}`;
        db.prepare(
          "INSERT INTO delivery_intents(id,identity,pod_id,task_id,generation,repository,branch,base_branch,state,created_at,updated_at) VALUES (?,?,?,?,1,'github.com/org/repo',?,'main','reserved',?,?)",
        ).run(id, id, podId, taskId, id, '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z');
        if (disposition !== null)
          db.prepare(
            "INSERT INTO delivery_receipts(id,intent_id,pr_url,evidence,disposition,result,recorded_at) VALUES (?, ?, ?, 'create_response', ?, 'malformed legacy result', ?)",
          ).run(`receipt-${id}`, id, url, disposition, '2026-09-07T00:00:00Z');
        return url;
      };
      insert('root', 'open', 'open');
      const reopened = insert('root', 'reopened', 'closed');
      ledger.observe(reopened, 'open');
      const closed = insert('fix', 'closed', 'open');
      ledger.observe(closed, 'closed');
      ledger.observe(closed, 'open');
      ledger.observe(closed, 'closed');
      const merged = insert('fix', 'merged', 'closed');
      ledger.observe(merged, 'merged');
      insert('root', 'unresolved', null);
      insert('rerun', 'separate', 'merged');
      db.pragma('ignore_check_constraints = ON');
      insert('fix', 'legacy-invalid', 'unknown-legacy-value');
      db.pragma('ignore_check_constraints = OFF');
      expect(repo.taskExecutions?.snapshot('fix').delivery).toEqual({
        intentCount: 6,
        receiptCount: 5,
        unresolvedCount: 1,
        scope: 'durable-receipts-only',
        disposition: {
          openCount: 2,
          mergedCount: 1,
          closedCount: 1,
          unavailableCount: 1,
          basis: 'last-recorded',
          liveVerified: false,
        },
      });
      expect(repo.taskExecutions?.snapshot('rerun').delivery).toMatchObject({
        receiptCount: 1,
        disposition: { mergedCount: 1, openCount: 0 },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_receipts').get()).toEqual({
        count: 6,
      });
      expect(repo.taskExecutions?.snapshot('fix').agentRunCount).toBe(0);
    } finally {
      db.close();
    }
  });
  it('retains healthy phase amounts after malformed and unknown phases without authorizing incomplete tokens', () => {
    const { db, repo } = fixture();
    try {
      const phases = JSON.stringify({
        review: null,
        future_unknown: { inputTokens: 900, outputTokens: 1, costUsd: 99 },
        advisory: { inputTokens: 5, outputTokens: 2, costUsd: 0.25 },
      });
      db.prepare(
        "UPDATE pods SET status='complete', completed_at=?, input_tokens=10, cost_usd=1, phase_token_usage=?, token_telemetry_accuracy='complete' WHERE id='root'",
      ).run(new Date().toISOString(), phases);
      const task = repo.taskExecutions?.snapshot('root');
      expect(task).toMatchObject({
        recordedCostUsd: 1.25,
        recordedInputTokens: 15,
        recordedOutputTokens: 2,
        budgetCheck: { status: 'unavailable' },
        costEvidence: { unavailablePhaseCount: 1, billingVerified: false },
      });
      expect(aggregateCost({ podRepo: repo }, { days: 1 }).total).toBe(1.25);
      expect(
        db.prepare("SELECT phase_token_usage AS phases FROM pods WHERE id='root'").get(),
      ).toEqual({ phases });
    } finally {
      db.close();
    }
  });

  it('rejects direct worker admission when a durable question remains pending', () => {
    const { db, repo } = fixture();
    try {
      db.prepare("UPDATE pods SET pending_escalation = ? WHERE id = 'root'").run(
        JSON.stringify({ id: 'pending-question', payload: { question: 'Continue?' } }),
      );
      expect(() => repo.taskExecutions?.beginRun('root', 1, 1, binding)).toThrow(
        'unanswered human decision',
      );
      expect(repo.taskExecutions?.snapshot('root').agentRunCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not authorize more budgeted work from an incomplete prior spending subtotal', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { inputTokens: 10, outputTokens: 5, tokenTelemetryAccuracy: 'partial' });
      expect(repo.taskExecutions?.snapshot('fix')).toMatchObject({
        recordedInputTokens: 10,
        recordedOutputTokens: 5,
        tokenBudget: 100,
        budgetCheck: { status: 'unavailable' },
      });
      expect(() => repo.taskExecutions?.beginRun('fix', 1, 1, binding)).toThrow(
        'Task token accounting incomplete',
      );
      expect(repo.taskExecutions?.snapshot('fix').agentRunCount).toBe(0);
      repo.update('root', { tokenTelemetryAccuracy: 'repaired', phaseTokenUsage: {} });
      expect(repo.taskExecutions?.snapshot('fix').budgetCheck?.status).toBe('below_recorded_limit');
      expect(repo.taskExecutions?.beginRun('fix', 1, 1, binding)).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  it('retains exclusive task admission across database reopen and releases it only on settlement', () => {
    const { db, repo } = fixture();
    repo.update('root', { tokenBudget: null, containerId: 'original-container' });
    repo.update('rerun', { tokenBudget: null });
    const ownedBinding = {
      ...binding,
      resource: { containerId: 'original-container', executionTarget: 'local' as const },
    };
    const run = repo.taskExecutions?.beginRun('root', 1, 1, ownedBinding);
    if (!run) throw new Error('Missing run');
    const dir = mkdtempSync(path.join(tmpdir(), 'outer-admission-'));
    const file = path.join(dir, 'state.db');
    writeFileSync(file, db.serialize());
    db.close();
    const first = new Database(file);
    const second = new Database(file);
    try {
      const a = createPodRepository(first).taskExecutions;
      const b = createPodRepository(second).taskExecutions;
      if (!a || !b) throw new Error('Missing ledger');
      expect(() => b.beginRun('fix', 1, 1, binding)).toThrow(/still active/);
      expect(() => b.beginRun('root', 1, 2, binding)).toThrow(/still active/);
      expect(b.beginRun('root', 1, 1, ownedBinding)).toBe(run);
      first
        .prepare("UPDATE pods SET container_id = 'replacement-container' WHERE id = 'root'")
        .run();
      expect(b.snapshot('fix').diagnostics.join('\n')).toContain(
        'Oldest unsettled run recorded local container original-container',
      );
      expect(b.snapshot('fix').diagnostics.join('\n')).not.toContain('replacement-container');
      expect(b.snapshot('rerun').diagnostics.join('\n')).not.toContain('unsettled worker');
      expect(() =>
        first.prepare("UPDATE task_agent_runs SET binding = '{}' WHERE id = ?").run(run),
      ).toThrow(/immutable/);
      expect(b.beginRun('rerun', 1, 1, binding)).toEqual(expect.any(String));
      a.finishRun(run, 'completed', null);
      expect(b.snapshot('fix').diagnostics.join('\n')).not.toContain('unsettled worker');
      expect(b.beginRun('fix', 1, 1, binding)).toEqual(expect.any(String));
      expect(first.prepare('SELECT COUNT(*) AS count FROM task_agent_runs').get()).toEqual({
        count: 3,
      });
      expect(first.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(first.pragma('foreign_key_check')).toEqual([]);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains unverified termination across restart and refuses ordinary settlement or identity replay', () => {
    const { db, repo } = fixture();
    repo.update('root', { tokenBudget: null, containerId: 'owned-container' });
    const ownedBinding = {
      ...binding,
      resource: { containerId: 'owned-container', executionTarget: 'local' as const },
    };
    const ledger = repo.taskExecutions;
    if (!ledger) throw new Error('Missing ledger');
    const run = ledger.beginRun('root', 1, 1, ownedBinding);
    ledger.retainUnverifiedRun(run);
    ledger.retainUnverifiedRun(run);
    const dir = mkdtempSync(path.join(tmpdir(), 'unverified-run-'));
    const file = path.join(dir, 'state.db');
    writeFileSync(file, db.serialize());
    db.close();
    const reopened = new Database(file);
    try {
      const restored = createPodRepository(reopened).taskExecutions;
      if (!restored) throw new Error('Missing ledger');
      expect(restored.hasActiveRun('root')).toBe(true);
      expect(restored.snapshot('fix')).toMatchObject({ agentRunCount: 1, failedRunCount: 1 });
      expect(() => restored.beginRun('root', 1, 1, ownedBinding)).toThrow(
        /termination.*unverified/,
      );
      expect(() => restored.beginRun('fix', 1, 1, binding)).toThrow(/still active/);
      for (const outcome of ['completed', 'failed', 'paused', 'stopped'] as const)
        expect(() => restored.finishRun(run, outcome, null)).toThrow(/termination.*unverified/);
      expect(
        reopened
          .prepare('SELECT ended_at, outcome, failure_category FROM task_agent_runs WHERE id = ?')
          .get(run),
      ).toEqual({
        ended_at: null,
        outcome: 'failed',
        failure_category: 'execution_termination_unverified',
      });
      expect(reopened.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(reopened.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains task/run identity through restart and linked fixes while intentional reruns remain distinct', () => {
    const { db, repo } = fixture();
    // This case tests lineage and settlement with no configured spending cap.
    repo.update('root', { tokenBudget: null });
    const ledger = repo.taskExecutions;
    if (!ledger) throw new Error('Missing ledger');
    const root = ledger.snapshot('root');
    expect(ledger.snapshot('fix').taskId).toBe(root.taskId);
    expect(ledger.snapshot('fix').executionId).not.toBe(root.executionId);
    expect(ledger.snapshot('rerun').taskId).not.toBe(root.taskId);
    const run = ledger.beginRun('root', 1, 1, binding);
    expect(ledger.beginRun('root', 1, 1, binding)).toBe(run);
    ledger.finishRun(run, 'failed', 'auth');
    expect(() => ledger.finishRun(run, 'completed', null)).toThrow('already settled');
    const dir = mkdtempSync(path.join(tmpdir(), 'task-ledger-'));
    const filename = path.join(dir, 'restart.db');
    writeFileSync(filename, db.serialize());
    db.close();
    const restarted = new Database(filename);
    try {
      const next = createPodRepository(restarted).taskExecutions;
      if (!next) throw new Error('Missing ledger');
      next.beginRun('fix', 1, 1, binding);
      expect(next.snapshot('fix')).toMatchObject({
        taskId: root.taskId,
        agentRunCount: 2,
        failedRunCount: 1,
      });
      expect(() => next.beginRun('fix', 1, 1, { ...binding, model: 'other' })).toThrow('binding');
    } finally {
      restarted.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts parent agent work and harness phases once and blocks a linked fix before further spending', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', {
        inputTokens: 60,
        outputTokens: 20,
        costUsd: 1,
        tokenTelemetryAccuracy: 'complete',
        phaseTokenUsage: {
          agent_initial: { inputTokens: 60, outputTokens: 20, costUsd: 1 },
          review: { inputTokens: 15, outputTokens: 5, costUsd: 0.25 },
        },
      });
      expect(repo.taskExecutions?.snapshot('fix')).toMatchObject({
        tokenBudget: 100,
        recordedInputTokens: 75,
        recordedOutputTokens: 25,
        recordedCostUsd: 1.25,
        podCount: 2,
        infrastructureCostUsd: null,
      });
      expect(() => repo.taskExecutions?.beginRun('fix', 1, 1, binding)).toThrow(
        'Task token budget',
      );
      expect(repo.taskExecutions?.snapshot('fix').agentRunCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('uses corrected provider telemetry instead of adding it to duplicate legacy pod totals', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { inputTokens: 50, outputTokens: 10, costUsd: 1 });
      db.prepare(`INSERT INTO provider_attempts (pod_id, ordinal, provider, runtime, model, profile_reference, profile_snapshot,
        started_at, ended_at, outcome, input_tokens, output_tokens, cost_usd)
        VALUES ('root', 1, 'openai', 'codex', 'model', 'pod:root@profile-snapshot#abcdef1', '{}',
          '2026-09-07T00:00:00Z', '2026-09-07T00:01:00Z', 'completed', 50, 10, 1)`).run();
      db.prepare(`INSERT INTO provider_attempt_telemetry_corrections
        (pod_id, ordinal, input_tokens, output_tokens, cost_usd, source, reason, corrected_at)
        VALUES ('root', 1, 20, 5, 0.5, 'codex_rollout', 'duplicate aggregate repaired', '2026-09-07T00:02:00Z')`).run();
      expect(repo.taskExecutions?.snapshot('fix')).toMatchObject({
        recordedInputTokens: 20,
        recordedOutputTokens: 5,
        recordedCostUsd: 0.5,
        providerAttemptCount: 1,
      });
      expect(repo.taskExecutions?.snapshot('fix').diagnostics).toContain(
        'root: provider ledger differs from legacy pod totals; corrected ledger used',
      );
      repo.update('root', { status: 'complete', completedAt: '2026-09-07T01:00:00Z' });
      const fleet = aggregateCost(
        { podRepo: repo, now: () => new Date('2026-09-07T02:00:00Z') },
        { days: 1 },
      );
      expect(fleet.total).toBe(repo.taskExecutions?.snapshot('root').recordedCostUsd);
    } finally {
      db.close();
    }
  });

  it('reports malformed phase telemetry without losing the other task records', () => {
    const { db, repo } = fixture();
    try {
      repo.update('root', { inputTokens: 9, outputTokens: 1 });
      db.prepare("UPDATE pods SET phase_token_usage = 'broken' WHERE id = 'fix'").run();
      const snapshot = repo.taskExecutions?.snapshot('root');
      expect(snapshot?.recordedInputTokens).toBe(9);
      expect(snapshot?.telemetry).toBe('partial');
      expect(snapshot?.diagnostics).toContain('fix: phase telemetry unreadable');
    } finally {
      db.close();
    }
  });

  it.each([139, 141, 152, 164])(
    'upgrades schema %s with existing linked work and unresolved legacy lineage',
    (version) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'task-upgrade-'));
      const migrations = path.resolve(import.meta.dirname, '../db/migrations');
      for (const file of readdirSync(migrations)) {
        if (Number.parseInt(file, 10) <= version)
          copyFileSync(path.join(migrations, file), path.join(dir, file));
      }
      const db = new Database(':memory:');
      try {
        runMigrations(db, dir, logger);
        insertTestProfile(db);
        for (const [id, parent] of [
          ['root', null],
          ['fix', 'root'],
          ['orphan', 'orphan'],
        ] as const) {
          db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id, linked_pod_id, input_tokens)
          VALUES (?, 'test-profile', 'original', 'failed', 'model', 'codex', 'branch', 'user', ?, 10)`).run(
            id,
            parent,
          );
        }
        runMigrations(db, migrations, logger);
        const repo = createPodRepository(db);
        const root = repo.taskExecutions?.snapshot('root');
        expect(repo.taskExecutions?.snapshot('fix')).toMatchObject({
          taskId: root?.taskId,
          podCount: 2,
          recordedInputTokens: 20,
          agentRunCount: 0,
        });
        expect(() => repo.taskExecutions?.snapshot('orphan')).toThrow('identity is unavailable');
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects stale duplicate run reservations after lifecycle replacement', () => {
    const { db, repo } = fixture();
    try {
      repo.taskExecutions?.beginRun('root', 1, 1, binding);
      repo.incrementLifecycleGeneration('root');
      expect(() => repo.taskExecutions?.beginRun('root', 1, 1, binding)).toThrow('Stale lifecycle');
    } finally {
      db.close();
    }
  });

  it('rejects changing task membership after execution identity has been assigned', () => {
    const { db, repo } = fixture();
    try {
      expect(() => repo.update('fix', { linkedPodId: 'rerun' })).toThrow('task membership');
      expect(repo.getOrThrow('fix').linkedPodId).toBe('root');
    } finally {
      db.close();
    }
  });
});

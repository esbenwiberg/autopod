import { expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { ReviewerRunRepository } from './reviewer-run-repository.js';

it.each(['unlimited', 'soft', 'hard', 'removed'] as const)(
  'admits in-flight review according to an explicit %s budget',
  async (mode) => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Review a canary',
          overrides: {
            workflow: {
              tokenBudget: mode === 'unlimited' ? null : 100000,
              tokenBudgetPolicy: mode === 'soft' ? 'soft' : 'hard',
            },
          },
        },
        services,
      );
      insertConfigurationTestPod(db, 'acceptance');
      db.prepare(
        "UPDATE pods SET launch_config_digest=?, token_budget=?, token_telemetry_accuracy='complete' WHERE id='acceptance'",
      ).run(config.digest, config.workflow.tokenBudget);
      db.exec(
        "INSERT INTO pod_goals(pod_id,objective,state,runtime,execution_stopped,native_session_id,last_sequence,observed_tokens,created_at,updated_at) VALUES('acceptance','Review a canary','active','codex',0,'session',3,100,'now','now')",
      );
      const repo = createPodRepository(db);
      const ledger = repo.taskExecutions;
      if (!ledger) throw new Error('Missing task ledger');
      ledger.register('acceptance');
      if (mode === 'removed') ledger.raiseBudget('acceptance', null, 100000, 'operator');
      const runs = new ReviewerRunRepository(db, (id) => ledger.snapshot(id));
      const pod = repo.getOrThrow('acceptance');
      expect(ledger.snapshot('acceptance').recordedTotalTokens).toBe(100);
      if (mode === 'hard') {
        expect(() => runs.reserve('in-flight', pod, config, config.ai.main)).toThrow(
          'Reconcile task usage',
        );
      } else {
        runs.reserve('in-flight', pod, config, config.ai.main);
        expect(db.prepare('SELECT state FROM isolated_reviewer_runs').get()).toEqual({
          state: 'preparing',
        });
        // Removing a budget never releases ownership of another running/uncertain reviewer.
        expect(() => runs.reserve('duplicate', pod, config, config.ai.main)).toThrow(
          'previous reviewer',
        );
      }
    } finally {
      db.close();
    }
  },
);

async function timedOutReview(policy: 'hard' | 'soft' = 'hard') {
  const db = createTestDb();
  const { services } = createTestConfiguration(db);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Review a canary',
      overrides: { workflow: { tokenBudget: 100000, tokenBudgetPolicy: policy } },
    },
    services,
  );
  insertConfigurationTestPod(db, 'stuck');
  db.prepare(
    "UPDATE pods SET launch_config_digest=?, token_budget=?, token_telemetry_accuracy='complete' WHERE id='stuck'",
  ).run(config.digest, config.workflow.tokenBudget);
  const repo = createPodRepository(db);
  const ledger = repo.taskExecutions;
  if (!ledger) throw new Error('Missing task ledger');
  ledger.register('stuck');
  const runs = new ReviewerRunRepository(db, (id) => ledger.snapshot(id));
  const pod = repo.getOrThrow('stuck');
  const id = 'review-00000000-0000-4000-8000-000000000001';
  // Dispatched, timed out, cleaned up — but the provider never reported usage.
  runs.reserve(id, pod, config, config.ai.main);
  runs.attach(id, 'sandbox-1');
  runs.running(id);
  runs.finish(id, true, false, undefined, 'timeout');
  runs.cleaned(id, true);
  return { db, config, ledger, runs, pod, id };
}

it('accepts unknown reviewer usage to unblock review even under a hard budget', async () => {
  const { db, config, ledger, runs, pod, id } = await timedOutReview('hard');
  try {
    expect(runs.retryBlocker('stuck')).toContain(id);
    expect(runs.get('stuck', id)?.requiresReconciliation).toBe(true);
    expect(ledger.snapshot('stuck').budgetCheck?.status).toBe('unavailable');
    expect(() => runs.reserve('review-next', pod, config, config.ai.main)).toThrow(
      'previous reviewer',
    );

    const reconciled = runs.reconcile('stuck', id, 'operator', 'Provider timed out');
    expect(reconciled).toMatchObject({
      state: 'uncertain',
      usageBasis: 'unknown-accepted',
      inputTokens: null,
      outputTokens: null,
      reconciledBy: 'operator',
      reconciliationNote: 'Provider timed out',
      requiresReconciliation: false,
    });
    expect(runs.retryBlocker('stuck')).toBeNull();
    const task = ledger.snapshot('stuck');
    expect(task.budgetCheck?.status).not.toBe('unavailable');
    expect(task.diagnostics.join('\n')).toContain('accepted with unknown usage');
    runs.reserve('review-next', pod, config, config.ai.main);
    expect(() => runs.reconcile('stuck', id, 'operator', 'again')).toThrow(
      'does not require reconciliation',
    );
  } finally {
    db.close();
  }
});

it('records operator-reported reviewer usage against the task', async () => {
  const { db, ledger, runs, id } = await timedOutReview('soft');
  try {
    const before = ledger.snapshot('stuck');
    runs.reconcile('stuck', id, 'operator', 'From provider console', {
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(runs.get('stuck', id)).toMatchObject({
      usageBasis: 'operator-reported',
      inputTokens: 1200,
      outputTokens: 300,
    });
    const after = ledger.snapshot('stuck');
    expect(after.recordedInputTokens - before.recordedInputTokens).toBe(1200);
    expect(after.recordedOutputTokens - before.recordedOutputTokens).toBe(300);
    expect(() =>
      runs.reconcile('stuck', id, 'operator', 'bad', { inputTokens: -1, outputTokens: 0 }),
    ).toThrow('non-negative');
  } finally {
    db.close();
  }
});

it('refuses to reconcile active, uncleaned or unknown reviewer runs', async () => {
  const { db, config, runs, pod, id } = await timedOutReview('soft');
  try {
    expect(() => runs.reconcile('stuck', 'review-missing', 'operator', 'x')).toThrow('not found');
    expect(() => runs.reconcile('other-pod', id, 'operator', 'x')).toThrow('not found');
    runs.cleaned(id, false);
    expect(() => runs.reconcile('stuck', id, 'operator', 'x')).toThrow('cleanup is not confirmed');
    runs.cleaned(id, true);
    runs.reconcile('stuck', id, 'operator', 'x');
    const active = 'review-00000000-0000-4000-8000-000000000002';
    runs.reserve(active, pod, config, config.ai.main);
    expect(() => runs.reconcile('stuck', active, 'operator', 'x')).toThrow('still active');
  } finally {
    db.close();
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_ACTOR,
  RECOVERY_REASON,
  RECOVERY_SANDBOX,
  terminationFixture,
} from '../test-utils/termination-reconciliation-helpers.js';
import { assertTaskExecutionTerminationVerified } from './task-execution-ledger.js';
import {
  WORKER_RETRY_BACKOFFS_MS,
  unavailableWorkerInputs,
  workerBindingHash,
} from './worker-retry-history.js';

describe('operator termination reconciliation', () => {
  const contexts: ReturnType<typeof terminationFixture>[] = [];
  function fixture() {
    const ctx = terminationFixture();
    contexts.push(ctx);
    return ctx;
  }
  afterEach(() => {
    vi.useRealTimers();
    for (const ctx of contexts.splice(0)) ctx.db.close();
  });

  it('uses historical ownership, atomically settles failure and retains an immutable, idempotent receipt', async () => {
    const ctx = fixture();
    const before = ctx.podRepo.getOrThrow(ctx.podId);
    expect(() => assertTaskExecutionTerminationVerified(ctx.ledger, ctx.podId)).toThrow(
      'unverified',
    );
    const receipt = await ctx.service.reconcileTermination(
      ctx.podId,
      ctx.runId,
      RECOVERY_REASON,
      RECOVERY_ACTOR,
    );
    expect(ctx.containerManager.getStatus).toHaveBeenCalledExactlyOnceWith(RECOVERY_SANDBOX);
    expect(receipt).toMatchObject({
      podId: ctx.podId,
      runId: ctx.runId,
      actor: RECOVERY_ACTOR,
      proof: 'sandbox-deleted',
      originalFailureCategory: 'execution_termination_unverified',
      resource: { containerId: RECOVERY_SANDBOX, executionTarget: 'sandbox' },
    });
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(false);
    expect(() => assertTaskExecutionTerminationVerified(ctx.ledger, ctx.podId)).not.toThrow();
    expect(ctx.ledger.snapshot(ctx.podId)).toMatchObject({ agentRunCount: 1, failedRunCount: 1 });
    expect(
      ctx.db
        .prepare('SELECT ended_at,outcome,failure_category FROM task_agent_runs WHERE id=?')
        .get(ctx.runId),
    ).toEqual({
      ended_at: receipt.reconciledAt,
      outcome: 'failed',
      failure_category: 'execution_termination_unverified',
    });
    expect(ctx.podRepo.getOrThrow(ctx.podId)).toEqual(before);
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.runtime.spawn).not.toHaveBeenCalled();
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).resolves.toEqual(receipt);
    expect(ctx.emitActivityStatus).toHaveBeenCalledTimes(1);
    expect(() =>
      ctx.db.prepare('UPDATE task_run_termination_reconciliations SET receipt=?').run('{}'),
    ).toThrow('immutable');
    expect(() => ctx.db.exec('DELETE FROM task_run_termination_reconciliations')).toThrow(
      'immutable',
    );
    expect(() =>
      ctx.db.prepare('UPDATE task_agent_runs SET ended_at=NULL WHERE id=?').run(ctx.runId),
    ).toThrow('immutable');
  });

  it.each(['running', 'stopped', 'unknown'] as const)(
    'refuses %s (not proof of exit)',
    async (status) => {
      const ctx = fixture();
      vi.mocked(ctx.containerManager.getStatus).mockResolvedValue(status);
      await expect(
        ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
      ).rejects.toThrow('only confirmed deletion');
      expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts).toEqual([]);
      expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
    },
  );

  it('refuses backend failure and bounded lookup timeout without releasing ownership', async () => {
    const ctx = fixture();
    vi.mocked(ctx.containerManager.getStatus).mockRejectedValueOnce(new Error('403 forbidden'));
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('unavailable');
    vi.useFakeTimers();
    vi.mocked(ctx.containerManager.getStatus).mockImplementation(() => new Promise(() => {}));
    const failed = expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
    expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts).toEqual([]);
  });

  it.each(['generation', 'resource', 'status', 'active'] as const)(
    'rechecks %s after async deletion observation',
    async (change) => {
      const ctx = fixture();
      vi.mocked(ctx.containerManager.getStatus).mockImplementation(async () => {
        if (change === 'generation') ctx.podRepo.incrementLifecycleGeneration(ctx.podId);
        if (change === 'resource')
          ctx.podRepo.update(ctx.podId, { containerId: 'another-resource' });
        if (change === 'status') ctx.podRepo.update(ctx.podId, { status: 'running' });
        if (change === 'active') ctx.isAgentActive.mockReturnValue(true);
        return 'deleted';
      });
      await expect(
        ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
      ).rejects.toThrow();
      expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
      expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts).toEqual([]);
    },
  );

  it('refuses automation, weak reasons and live in-memory workers before probing', async () => {
    const ctx = fixture();
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, {
        type: 'automation',
        id: 'bot',
      }),
    ).rejects.toThrow('human');
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, 'retry', RECOVERY_ACTOR),
    ).rejects.toThrow('meaningful');
    ctx.isAgentActive.mockReturnValue(true);
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('active worker');
    expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
  });

  it('fails closed for legacy or non-sandbox ownership rather than using current resource fields', async () => {
    const ctx = fixture();
    // Insert legacy historical evidence before identity immutability takes effect.
    ctx.db
      .prepare(`INSERT INTO task_agent_runs(id,pod_id,generation,cycle,binding,started_at,outcome,failure_category)
      VALUES('legacy',?,1,2,?,'now','failed','execution_termination_unverified')`)
      .run(ctx.podId, '{}');
    await expect(
      ctx.service.reconcileTermination(ctx.podId, 'legacy', RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('ownership unavailable');
    expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
  });

  it('names linked owner and never settles another pod by inference', async () => {
    const ctx = fixture();
    const child = ctx.manager.createSession(
      { profileName: 'test-profile', task: 'Related work', linkedPodId: ctx.podId },
      'operator',
    );
    expect(ctx.ledger.terminationReconciliations(child.id).pending[0]?.podId).toBe(ctx.podId);
    await expect(
      ctx.service.reconcileTermination(child.id, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow(`owner pod ${ctx.podId}`);
    expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
    await ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR);
    expect(ctx.ledger.hasUnverifiedTermination(child.id)).toBe(false);
    expect(ctx.ledger.terminationReconciliations(child.id).receipts).toHaveLength(1);
  });

  it('clears only an exact stale deleted reference so normal Rework can use retained source', async () => {
    const ctx = fixture();
    ctx.podRepo.update(ctx.podId, { containerId: RECOVERY_SANDBOX });
    await ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR);
    expect(ctx.podRepo.getOrThrow(ctx.podId)).toMatchObject({
      containerId: null,
      status: 'failed',
      worktreePath: '/tmp/retained-source',
    });
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts[0]?.resource.containerId).toBe(
      RECOVERY_SANDBOX,
    );
  });

  it('keeps native Goal recovery separate', async () => {
    const ctx = fixture();
    ctx.db
      .prepare(`INSERT INTO pod_goals(pod_id,objective,state,runtime,created_at,updated_at)
      VALUES(?,'Objective','failed','codex','now','now')`)
      .run(ctx.podId);
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('Native Goals');
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
  });

  it('releases the manager termination gate but leaves worker retry authorization in force', async () => {
    const ctx = fixture();
    const pod = ctx.podRepo.getOrThrow(ctx.podId);
    const retries = ctx.podRepo.workerRetries;
    if (!retries) throw new Error('Missing worker retry ledger');
    const admission = retries.admit(
      ctx.podId,
      pod.lifecycleGeneration,
      unavailableWorkerInputs,
      workerBindingHash({ runtime: pod.runtime, model: pod.model, providerAccountId: null }),
      [...WORKER_RETRY_BACKOFFS_MS],
      ctx.runId,
    );
    retries.start(admission.id);
    retries.finish(admission.id, 'unknown', null);
    expect(() => ctx.manager.assertCanRework(ctx.podId)).toThrow('unverified process termination');
    await ctx.manager.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR);
    expect(() => ctx.manager.assertCanRework(ctx.podId)).toThrow('authorized retry');
    expect(retries.state(ctx.podId).authorizations).toEqual([]);
    retries.authorize(ctx.podId, 'operator-retry-1', RECOVERY_REASON, RECOVERY_ACTOR);
    expect(() => ctx.manager.assertCanRework(ctx.podId)).not.toThrow();
    await ctx.manager.triggerValidation(ctx.podId, { force: true });
    expect(ctx.podRepo.getOrThrow(ctx.podId)).toMatchObject({
      status: 'queued',
      recoveryWorktreePath: '/tmp/retained-source',
    });
    expect(ctx.enqueuedSessions).toContain(ctx.podId);
  });

  it('rejects stale or mismatched evidence again at the atomic settlement boundary', async () => {
    const original = fixture();
    const receipt = await original.service.reconcileTermination(
      original.podId,
      original.runId,
      RECOVERY_REASON,
      RECOVERY_ACTOR,
    );
    const ctx = fixture();
    const input = {
      ...receipt,
      podId: ctx.podId,
      runId: ctx.runId,
      taskId: ctx.ledger.snapshot(ctx.podId).taskId,
    };
    expect(() =>
      ctx.ledger.reconcileUnverifiedRun({
        ...input,
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toThrow('Fresh');
    expect(() =>
      ctx.ledger.reconcileUnverifiedRun({
        ...input,
        observedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toThrow('Fresh');
    expect(() => ctx.ledger.reconcileUnverifiedRun({ ...input, cycle: input.cycle + 1 })).toThrow(
      'changed',
    );
    expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts).toEqual([]);
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
  });

  it('rolls back the receipt if settlement fails', async () => {
    const ctx = fixture();
    ctx.db.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE OF ended_at ON task_agent_runs
      BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END;`);
    await expect(
      ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
    ).rejects.toThrow('injected');
    expect(ctx.ledger.terminationReconciliations(ctx.podId).receipts).toEqual([]);
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
  });

  it('coalesces concurrent receipt writes and retains audit through pod archival', async () => {
    const ctx = fixture();
    const results = await Promise.all(
      [1, 2].map(() =>
        ctx.service.reconcileTermination(ctx.podId, ctx.runId, RECOVERY_REASON, RECOVERY_ACTOR),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    ctx.podRepo.delete(ctx.podId);
    expect(ctx.ledger.terminationReconciliations(ctx.podId)).toEqual({
      pending: [],
      receipts: [results[0]],
    });
    expect(
      ctx.db.prepare('SELECT outcome FROM retained_task_agent_runs WHERE id=?').get(ctx.runId),
    ).toEqual({ outcome: 'failed' });
  });
});

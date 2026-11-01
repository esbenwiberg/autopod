import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockedCheckpointOutcomeFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
async function fixture() {
  const f = await retainedCheckpointFixture('wakeup');
  fixtures.push(f);
  const input = await blockedCheckpointOutcomeFixture(f);
  expect(f.recovery.list(f.podId)[0]).toMatchObject({
    checked: null,
    blocked: { code: 'CHECKPOINT_SOURCE_CHANGED' },
  });
  return { ...f, reconciliation: input };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('explicit already-completed checkpoint failure reconciliation', () => {
  it('appends an audited failed outcome without running anything, granting retry, waiving checks or releasing the original', async () => {
    const f = await fixture();
    const before = f.pod();
    const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
    const checks = vi.mocked(f.ctx.validationEngine.validate).mock.calls.length;
    const spawns = vi.mocked(f.cm.spawn).mock.calls.length;
    const starts = vi.mocked(f.cm.start!).mock.calls.length;
    const result = await f.recovery.reconcileOutcome(
      f.podId,
      f.input.id,
      f.reconciliation,
      f.actor,
    );
    expect(result.checked).toMatchObject({
      resultHash: f.reconciliation.expectedResultHash,
      result: { overall: 'fail' },
      snapshot: null,
    });
    expect(result.reconciled).toMatchObject({
      actor: f.actor,
      generation: 2,
      source: { head: f.reconciliation.expectedHead },
    });
    expect(result.reconciled?.source.checkpoints.length).toBeGreaterThan(0);
    expect(result.blocked?.code).toBe('CHECKPOINT_SOURCE_CHANGED'); // Historical evidence stays immutable.
    expect(f.pod()).toEqual(before);
    expect(f.pod().status).toBe('review_required');
    expect(f.pod().validationWaiver).toBeNull();
    expect(f.ctx.podRepo.taskRetries!.state(f.podId)).toEqual(retries);
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(checks);
    expect(f.cm.spawn).toHaveBeenCalledTimes(spawns);
    expect(f.cm.start).toHaveBeenCalledTimes(starts);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(() => f.ctx.podRepo.retainedCheckpoints!.assertAvailable(f.podId)).not.toThrow();
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, f.containerId)).toThrow(
      'retains unknown',
    );
    expect(f.ctx.podRepo.sandboxWakeups!.listForPod(f.podId)[0]?.endedAt).toBeNull();
    expect(() => f.ctx.podRepo.delete(f.podId)).toThrow();
    expect(createRetainedCheckpointRepository(f.ctx.db).latest(f.podId)?.reconciled).toEqual(
      result.reconciled,
    );
    for (const sql of [
      "UPDATE retained_checkpoint_outcome_reconciliations SET evidence='{}'",
      'DELETE FROM retained_checkpoint_outcome_reconciliations',
    ])
      expect(() => f.ctx.db.exec(sql)).toThrow();
  });
  it('replays the same bound request as an observation, but refuses a different actor or reason', async () => {
    const f = await fixture();
    const first = await f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor);
    const reads = f.worktrees.inspectSourceAdoption.mock.calls.length;
    expect(
      await f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor),
    ).toEqual(first);
    expect(f.worktrees.inspectSourceAdoption).toHaveBeenCalledTimes(reads);
    for (const [request, actor] of [
      [{ ...f.reconciliation, reason: 'A different human reconciliation reason' }, f.actor],
      [f.reconciliation, { type: 'human' as const, userId: 'another' }],
    ] as const)
      await expect(
        f.recovery.reconcileOutcome(f.podId, f.input.id, request, actor),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_CONFLICT' });
  });
  it('requires an authenticated human and exact current generation, result and observed head', async () => {
    const f = await fixture();
    await expect(
      f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, {
        type: 'automation',
        id: 'worker',
      }),
    ).rejects.toThrow('human');
    for (const request of [
      { ...f.reconciliation, expectedGeneration: 3 },
      { ...f.reconciliation, expectedResultHash: '0'.repeat(64) },
      { ...f.reconciliation, expectedHead: 'e'.repeat(40) },
    ])
      await expect(
        f.recovery.reconcileOutcome(f.podId, f.input.id, request, f.actor),
      ).rejects.toThrow();
    expect(f.recovery.list(f.podId)[0]?.reconciled).toBeNull();
  });
  it('refuses changed tracked source and retains the block', async () => {
    const f = await fixture();
    await writeFile(path.join(f.pod().worktreePath!, 'source.ts'), 'Changed after checks\n');
    await expect(
      f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor),
    ).rejects.toThrow();
    expect(f.recovery.list(f.podId)[0]?.reconciled).toBeNull();
  });
  it.each(['pass', 'unverified-exit'] as const)(
    'does not reinterpret %s evidence as a failed completed outcome',
    async (kind) => {
      const f = await fixture();
      const result = { ...f.pod().lastValidationResult! };
      if (kind === 'pass') result.overall = 'pass';
      else
        result.infrastructureFailure = {
          phase: 'test',
          code: 'EXEC_EXIT_UNVERIFIED',
          retryable: false,
          message: 'Unknown replacement exit',
          execution: { cause: 'timeout', cleanup: 'failed', timeoutMs: 900000 },
        };
      // Simulate projection drift; immutable dispatch/result rows remain untouched.
      f.ctx.db
        .prepare('UPDATE pods SET last_validation_result=? WHERE id=?')
        .run(JSON.stringify(result), f.podId);
      await expect(
        f.recovery.reconcileOutcome(
          f.podId,
          f.input.id,
          {
            ...f.reconciliation,
            expectedResultHash: checkpointHash(result),
          },
          f.actor,
        ),
      ).rejects.toThrow();
      expect(f.recovery.list(f.podId)[0]?.reconciled).toBeNull();
    },
  );
  it('rejects frozen configuration drift and a missing exact immutable dispatch', async () => {
    const f = await fixture();
    const execution = f.deps.executionForPod;
    f.deps.executionForPod = (pod) => ({ ...execution(pod), buildCommand: 'different build' });
    await expect(
      f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor),
    ).rejects.toThrow('configuration');
    f.deps.executionForPod = execution;
    vi.spyOn(f.ctx.podRepo.validationExecutions!, 'find').mockReturnValue(null);
    await expect(
      f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor),
    ).rejects.toThrow('published replacement');
    expect(f.recovery.list(f.podId)[0]?.reconciled).toBeNull();
  });
  it('refuses an active invocation, even when source and the saved result match', async () => {
    const f = await fixture();
    vi.mocked(f.deps.isIdle).mockReturnValue(false);
    await expect(
      f.recovery.reconcileOutcome(f.podId, f.input.id, f.reconciliation, f.actor),
    ).rejects.toThrow('not idle');
    expect(f.recovery.list(f.podId)[0]?.reconciled).toBeNull();
  });
});

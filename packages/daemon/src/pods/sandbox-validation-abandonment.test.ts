import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFailingValidationResult, logger } from '../test-utils/mock-helpers.js';
import {
  sandboxRecoveryFixture,
  sandboxValidationAbandonmentFixture,
} from '../test-utils/sandbox-recovery-helpers.js';
import { createSandboxRecovery } from './sandbox-recovery.js';
import { assertSourceResourceReleasable } from './source-custody-guards.js';
import {
  assertTaskValidationDeletable,
  assertTaskValidationSettled,
  assertValidationResourceSettled,
} from './validation-execution-evidence.js';
import {
  assertValidationDeletionAllowed,
  assertValidationMutationSettled,
} from './validation-recovery-policy.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';

function appendDispatch(f: ReturnType<typeof sandboxValidationAbandonmentFixture>, active = false) {
  const id = randomUUID();
  const prior = f.db
    .prepare('SELECT * FROM task_retry_attempts WHERE id=?')
    .get(f.admission.id) as Record<string, string | number | null>;
  const admission = {
    ...prior,
    id: randomUUID(),
    ...(active ? { ended_at: null, outcome: null, measured_duration_ms: null } : {}),
  };
  f.db
    .prepare(
      `INSERT INTO task_retry_attempts (${Object.keys(admission).join(',')}) VALUES (${Object.keys(
        admission,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(admission));
  f.db
    .prepare(`INSERT INTO validation_dispatches
    SELECT ?,pod_id,task_id,generation,cycle,?,json_set(binding,'$.admissionId',?),created_at
    FROM validation_dispatches WHERE id=?`)
    .run(id, admission.id, admission.id, f.dispatch);
  return id;
}

describe('explicit destruction of validation-held sandboxes', () => {
  it('exposes abandonment, not Start, without mutating or claiming validation settlement', async () => {
    const f = sandboxValidationAbandonmentFixture();
    const before = f.pod();
    const inspected = await f.recovery.inspect('prepare');
    expect(inspected.resources[0]?.startBlocked).toContain('termination is unverified');
    expect(inspected.resources[0]?.abandonBlocked).toBeNull();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.pod()).toEqual(before);
    await expect(
      f.recovery.submit('prepare', { ...f.input, action: 'start' }, f.actor),
    ).rejects.toThrow('termination is unverified');
    await expect(
      f.recovery.submit('prepare', { ...f.input, acknowledgeDataLoss: false }, f.actor),
    ).rejects.toThrow('acknowledgement');
    expect(f.journal.recovery.list('prepare')).toEqual([]);
  });

  it('allows exact provider DELETE and pod cleanup only in the audited scope, without changing validation evidence', async () => {
    const f = sandboxValidationAbandonmentFixture();
    const originalDispatches = f.db.prepare('SELECT * FROM validation_dispatches').all();
    const originalResults = f.db.prepare('SELECT * FROM validation_dispatch_results').all();
    expect(() => f.podRepo.delete('prepare')).toThrow('unverified');
    expect(() => assertSourceResourceReleasable(f.db, f.sandboxId)).toThrow('retains this exact');
    f.cm.kill.mockImplementation(async () => {
      expect(f.journal.recovery.get(f.input.id)?.validationEvidence).toContain(f.dispatch);
      expect(() => assertSourceResourceReleasable(f.db, f.sandboxId)).not.toThrow();
      // Before GET 404, only resource destruction is authorized, not pod cleanup.
      expect(() => assertTaskValidationDeletable(f.db, 'prepare')).toThrow('unverified');
      expect(() => assertValidationDeletionAllowed(f.podRepo, 'prepare')).toThrow('unverified');
      // A destruction capability is not a start, validation, retry or worker grant.
      expect(() => assertValidationResourceSettled(f.db, f.sandboxId)).toThrow(
        'retains this exact',
      );
      expect(() => assertValidationMutationSettled(f.podRepo, 'prepare')).toThrow('unverified');
      expect(() => assertTaskValidationSettled(f.db, 'prepare')).toThrow('unverified');
      f.setState('deleted');
    });
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(result.operation.validationEvidence).toContain(f.dispatch);
    expect(result.operation.completedAt).not.toBeNull();
    expect(f.db.prepare('SELECT * FROM validation_dispatches').all()).toEqual(originalDispatches);
    expect(f.db.prepare('SELECT * FROM validation_dispatch_results').all()).toEqual(
      originalResults,
    );
    expect(f.db.prepare('SELECT * FROM validation_recovery_intents').all()).toEqual([]);
    expect(() => assertSourceResourceReleasable(f.db, f.sandboxId)).toThrow('retains this exact');
    expect((await f.recovery.submit('prepare', f.input, f.actor)).podDeleted).toBe(true);
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])('runs full workspace cleanup and can resume a settled failed cleanup attempt (interrupted=%s)', async (interrupted) => {
    const f = sandboxValidationAbandonmentFixture();
    const cleanup = vi.fn(async () => {});
    const deletion = createWorkspaceDeletion({
      podRepo: f.podRepo,
      executionForPod: f.captured.resolveEffectiveBoundProfile,
      clearPreviewTimer: vi.fn(),
      stopSandboxPreviewProxy: cleanup,
      killSidecarsForPod: cleanup,
      containerManagerFactory: { get: () => f.cm },
      destroyPodNetwork: cleanup,
      cleanupTestRunBranches: cleanup,
      worktreeManager: f.worktreeManager,
      pendingUpdateFromBaseIntents: new Set(),
      forceWithLeaseAllowances: new Set(),
      logger,
    });
    await expect(deletion.deleteSession('prepare')).rejects.toThrow('unverified');
    f.deleteSession.mockImplementation(deletion.deleteSession);
    if (interrupted) {
      vi.mocked(f.worktreeManager.cleanup).mockRejectedValueOnce(
        new Error('temporary worktree cleanup error'),
      );
      const first = await f.recovery.submit('prepare', f.input, f.actor);
      expect(first.podDeleted).toBe(false);
      expect(first.cleanupError).toContain('worktree');
      const inspected = await f.recovery.inspect('prepare');
      expect(inspected.resources[0]?.abandonBlocked).toBeNull();
      expect(inspected.resources[0]?.abandonment?.id).toBe(f.input.id);
    }
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result).toMatchObject({ podDeleted: true, cleanupError: null });
    expect(f.worktreeManager.cleanup).toHaveBeenCalled();
    expect(
      f.db
        .prepare('SELECT completed_at FROM deletion_cleanup_intents WHERE pod_id=?')
        .get('prepare'),
    ).toMatchObject({ completed_at: expect.any(String) });
  });

  it('does not release pod deletion for a missing or unconfirmed provider deletion', async () => {
    const f = sandboxValidationAbandonmentFixture();
    f.cm.kill.mockImplementation(async () => {
      assertSourceResourceReleasable(f.db, f.sandboxId);
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow(
      'Deletion is not confirmed',
    );
    expect(f.deleteSession).not.toHaveBeenCalled();
    expect(f.journal.recovery.get(f.input.id)?.completedAt).toBeNull();
    expect(() => f.podRepo.delete('prepare')).toThrow('unverified');
    expect(() => assertSourceResourceReleasable(f.db, f.sandboxId)).toThrow();
    expect(f.pod().lastValidationResult).toEqual(f.result);
  });

  it('reconciles a lost DELETE response across SQLite reopen without replaying DELETE or fabricating a receipt', async () => {
    const f = sandboxValidationAbandonmentFixture(true);
    f.cm.kill.mockImplementation(async () => {
      assertSourceResourceReleasable(f.db, f.sandboxId);
      f.setState('deleted');
      throw new Error('response lost');
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('response lost');
    const reopened = f.reopen();
    const next = createSandboxRecovery({
      ...f.deps,
      podRepo: reopened.pods,
      deleteSession: async (id) => reopened.pods.delete(id),
    });
    const result = await next.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
    expect(result.operation.validationEvidence).toContain(f.dispatch);
    expect(reopened.pods.validationExecutions?.intent(f.dispatch)).toBeNull();
  });

  it.each([
    'generation',
    'dispatch',
    'namespace',
  ] as const)('rechecks %s after provider/auth work, before the transport fence', async (change) => {
    const f = sandboxValidationAbandonmentFixture();
    let passed = false;
    let added: string | undefined;
    f.cm.kill.mockImplementation(async () => {
      await Promise.resolve();
      if (change === 'generation') f.podRepo.incrementLifecycleGeneration('prepare');
      if (change === 'dispatch') added = appendDispatch(f);
      if (change === 'namespace') f.cm.executionResourceScope = 'other-provider-namespace';
      assertSourceResourceReleasable(f.db, f.sandboxId);
      passed = true;
      f.setState('deleted');
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow();
    expect(passed).toBe(false);
    if (change === 'dispatch') expect(added).toEqual(expect.any(String));
    expect(f.deleteSession).not.toHaveBeenCalled();
    expect(f.journal.recovery.get(f.input.id)?.completedAt).toBeNull();
  });

  it('requires fresh confirmation for newly retained dispatch evidence, not permanent orphaning', async () => {
    const f = sandboxValidationAbandonmentFixture();
    f.cm.kill.mockRejectedValueOnce(new Error('before dispatch'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('before dispatch');
    const added = appendDispatch(f);
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('superseded');
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonment).toBeNull();
    const result = await f.recovery.submit(
      'prepare',
      { ...f.input, id: 'fresh-validation-loss-decision' },
      f.actor,
    );
    expect(result.podDeleted).toBe(true);
    expect(result.operation.validationEvidence).toContain(added);
  });

  it('never upgrades a pre-existing decision with no captured validation authority', async () => {
    const f = sandboxValidationAbandonmentFixture();
    // A migrated decision has NULL validation_evidence, not a retrospective grant.
    const capture = vi.spyOn(f.validations, 'captureAbandonment').mockReturnValue(null);
    f.cm.kill.mockRejectedValueOnce(new Error('before deletion'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('before deletion');
    capture.mockRestore();
    expect(f.journal.recovery.get(f.input.id)?.validationEvidence).toBeNull();
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('superseded');
    const result = await f.recovery.submit(
      'prepare',
      { ...f.input, id: 'fresh-explicit-validation-abandonment' },
      f.actor,
    );
    expect(result.podDeleted).toBe(true);
    expect(f.journal.recovery.get(f.input.id)?.validationEvidence).toBeNull();
  });

  it('forbids rewriting validation selection even in the otherwise permitted completion update', async () => {
    const f = sandboxValidationAbandonmentFixture();
    f.cm.kill.mockRejectedValueOnce(new Error('unconfirmed'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('unconfirmed');
    f.journal.recovery.append(f.input.id, 'deleted');
    expect(() =>
      f.db
        .prepare(
          "UPDATE sandbox_recovery_requests SET completed_at=?,validation_evidence='[]' WHERE id=?",
        )
        .run(new Date().toISOString(), f.input.id),
    ).toThrow('Validation abandonment evidence is immutable');
    expect(f.journal.recovery.get(f.input.id)?.completedAt).toBeNull();
  });

  it('refuses an actual active validation admission even with explicit loss consent', async () => {
    const f = sandboxValidationAbandonmentFixture();
    appendDispatch(f, true);
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'execution/admission is active',
    );
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow(
      'execution/admission is active',
    );
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it.each([
    'shared-resource',
    'other-task-owner',
  ] as const)('does not discard %s custody', async (kind) => {
    const f = sandboxValidationAbandonmentFixture();
    const child = f.insertFix('failed');
    if (kind === 'shared-resource') {
      f.podRepo.update(child.id, { containerId: null });
      f.podRepo.update(child.id, { executionTarget: 'sandbox', containerId: f.sandboxId });
    } else {
      f.podRepo.update(child.id, { lastValidationResult: { ...f.result, podId: child.id } });
    }
    const inspected = await f.recovery.inspect('prepare');
    expect(inspected.resources[0]?.abandonBlocked).toContain(
      kind === 'shared-resource' ? 'another pod' : 'Another task owner',
    );
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('still blocks legacy ownership, other provider namespaces, active work and independent custody', async () => {
    const legacy = sandboxRecoveryFixture(false);
    legacy.podRepo.update('prepare', {
      lastValidationResult: {
        ...createFailingValidationResult('prepare'),
        infrastructureFailure: {
          phase: 'test',
          code: 'EXEC_EXIT_UNVERIFIED',
          message: 'unknown exit',
          retryable: false,
        },
      },
    });
    expect((await legacy.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'Immutable validation ownership',
    );
    const f = sandboxValidationAbandonmentFixture();
    f.cm.executionResourceScope = 'different';
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'namespace',
    );
    f.cm.executionResourceScope = 'test-scope';
    f.setIdle(false);
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'still active',
    );
    f.setIdle(true);
    vi.spyOn(f.validations, 'assertNoActiveTaskExecution').mockImplementation(() => {
      throw new Error('active validation admission');
    });
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'active validation',
    );
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('revokes cleanup authority when its callback fails, even for delayed async work', async () => {
    const f = sandboxValidationAbandonmentFixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed: Promise<unknown> | undefined;
    f.deleteSession.mockImplementation(async () => {
      delayed = (async () => {
        await gate;
        try {
          assertSourceResourceReleasable(f.db, f.sandboxId);
          return 'unexpected permission';
        } catch (error) {
          return error;
        }
      })();
      throw new Error('cleanup failed');
    });
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(false);
    release();
    expect(await delayed).toMatchObject({
      code: 'STALE_SANDBOX_RECOVERY',
      message: 'Validation abandonment capability expired',
    });
  });

  it('retains immutable validation selection and human decision after resource deletion when cleanup fails', async () => {
    const f = sandboxValidationAbandonmentFixture();
    f.deleteSession.mockRejectedValue(new Error('worktree cleanup failed'));
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result).toMatchObject({ podDeleted: false, cleanupError: 'worktree cleanup failed' });
    expect(f.pod().lastValidationResult).toEqual(f.result);
    expect(() =>
      f.db.prepare("UPDATE sandbox_recovery_requests SET validation_evidence='[]'").run(),
    ).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM sandbox_recovery_requests').run()).toThrow('retained');
    expect(() => f.podRepo.delete('prepare')).toThrow('unverified');
    f.deleteSession.mockImplementation(async (id) => f.podRepo.delete(id));
    expect((await f.recovery.submit('prepare', f.input, f.actor)).podDeleted).toBe(true);
  });
});

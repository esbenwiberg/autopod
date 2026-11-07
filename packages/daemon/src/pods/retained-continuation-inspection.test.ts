import { rm } from 'node:fs/promises';
import { AutopodError } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  preValidationCheckpointFixture,
  recordPreValidationInfrastructure,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { createCompletionGuards } from './completion-guards.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { checkpointHash } from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof preValidationCheckpointFixture>>[] = [];
async function fixture() {
  const f = await preValidationCheckpointFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('read-only retained-continuation inspection', () => {
  it.each([
    true,
    false,
  ])('matches additive-review admission for omitted workflow review (frozen route=%s)', async (independentRoute) => {
    const f = recordPreValidationInfrastructure(
      await retainedCheckpointFixture('validation', true, false, independentRoute, 'local'),
    );
    fixtures.push(f);
    const launch = f.ctx.deps.launchConfiguration;
    if (!launch) throw new Error('Missing native launch');
    f.deps.readLaunch = launch.read;
    const controller = createRetainedCheckpointRecovery(f.deps);
    const before = launch.read(f.podId);
    f.ctx.db.pragma('query_only = ON');
    const inspection = controller.inspect(f.podId);
    expect(inspection.status).toBe(independentRoute ? 'requires_selection' : 'blocked');
    expect(inspection.checks.find((check) => check.id === 'continuation_policy')?.state).toBe(
      independentRoute ? 'no_recorded_blocker' : 'blocked',
    );
    expect(launch.read(f.podId)).toEqual(before);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    f.ctx.db.pragma('query_only = OFF');
  });
  it('shows report-bound selection without qualifying source/resources or changing any durable state', async () => {
    const f = await fixture();
    const before = f.pod();
    const ledger = f.ctx.podRepo.taskRetries;
    if (!ledger) throw new Error('Missing retry fixture');
    const retries = ledger.state(f.podId);
    // Any attempted ledger mutation during inspection fails this test.
    f.ctx.db.pragma('query_only = ON');
    const inspection = f.recovery.inspect(f.podId);
    expect(f.recovery.inspect(f.podId)).toEqual(inspection);
    expect(inspection).toMatchObject({
      version: 1,
      mode: 'read_only',
      status: 'requires_selection',
      generation: 1,
      selection: { expectedGeneration: 1, expectedResultHash: f.input.expectedResultHash },
      infrastructure: {
        state: 'reported',
        needs: [
          {
            id: f.report.id,
            owner: 'validation',
            phase: f.report.payload.phase,
            needs: f.report.payload.needs,
          },
        ],
      },
      prerequisites: {
        hostPathRecorded: true,
        sourcePreservationRecorded: true,
        workerSettlementRecorded: true,
        pendingDecision: false,
        hostSource: 'not_checked',
        originalFilesAndReports: 'not_checked',
        resourceStateAndIdentity: 'not_checked',
        environmentQualification: 'not_checked',
        retryAdmission: 'not_checked',
      },
    });
    expect(f.pod()).toEqual(before);
    expect(ledger.state(f.podId)).toEqual(retries);
    expect(f.ctx.escalationRepo.getOrThrow(f.report.id)).toEqual(f.originalReport);
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.worktrees.inspectSourceAdoption).not.toHaveBeenCalled();
    for (const method of [
      'spawn',
      'start',
      'stop',
      'kill',
      'getStatus',
      'getResourceKey',
      'execInContainer',
      'writeFile',
    ] as const)
      expect(f.cm[method]).not.toHaveBeenCalled();
    f.ctx.db.pragma('query_only = OFF');
  });

  it.each([
    'incomplete',
    'oversized',
    'too-many',
    'combined-bound',
  ])('retains bounded needs and refusal for %s selection evidence without changing admission', async (kind) => {
    const f = await fixture();
    if (kind === 'incomplete' || kind === 'oversized')
      f.ctx.db.prepare('UPDATE escalations SET payload=? WHERE id=?').run(
        JSON.stringify({
          ...f.report.payload,
          ...(kind === 'incomplete' ? { phase: undefined } : { needs: 'n'.repeat(70000) }),
        }),
        f.report.id,
      );
    else
      for (let index = 0; index < (kind === 'too-many' ? 100 : 18); index++)
        f.ctx.escalationRepo.insert({
          ...f.report,
          id: `additional-${index}`,
          payload: {
            ...f.report.payload,
            ...(kind === 'combined-bound' ? { needs: 'n'.repeat(60000) } : {}),
          },
        });
    const before = f.pod();
    const reports = f.ctx.escalationRepo.listBySession(f.podId);
    f.ctx.db.pragma('query_only=ON');
    const inspection = f.recovery.inspect(f.podId);
    expect(f.recovery.inspect(f.podId)).toEqual(inspection);
    expect(inspection.status).toBe('blocked');
    expect(inspection.selection).toBeNull();
    expect(inspection.checks).toContainEqual(
      expect.objectContaining({
        id: 'selection_evidence',
        state: 'blocked',
        code: 'CHECKPOINT_RECOVERY_BLOCKED',
        reason: expect.stringContaining(kind === 'incomplete' ? 'incomplete' : 'safe bound'),
      }),
    );
    expect(inspection.infrastructure.state).toBe('reported');
    expect(inspection.infrastructure.needs.length).toBeGreaterThan(0);
    expect(inspection.infrastructure.needs.length).toBeLessThanOrEqual(20);
    expect(inspection.infrastructure.needs.every((need) => (need.needs?.length ?? 0) <= 1024)).toBe(
      true,
    );
    expect(() => f.recovery.selection(f.podId)).toThrowError(
      expect.objectContaining({ code: 'CHECKPOINT_RECOVERY_BLOCKED' }),
    );
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'CHECKPOINT_RECOVERY_BLOCKED',
    });
    expect(f.pod()).toEqual(before);
    expect(f.ctx.escalationRepo.listBySession(f.podId)).toEqual(reports);
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Selection DB failure'),
    new AutopodError('Selection programming failure', 'UNEXPECTED', 409),
    new AutopodError('Selection authentication failure', 'UNAUTHORIZED', 401),
    new AutopodError('Selection storage failure', 'CHECKPOINT_RECOVERY_BLOCKED', 500),
  ])('does not suppress unexpected selection failure: %s', async (error) => {
    const f = await fixture();
    const repo = f.ctx.podRepo.retainedCheckpoints;
    if (!repo) throw new Error('Missing checkpoint repository');
    vi.spyOn(repo, 'selectionEvidence').mockImplementation(() => {
      throw error;
    });
    expect(() => f.recovery.inspect(f.podId)).toThrow(error);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('preserves the existing result hash and independently shows current reported needs', async () => {
    const f = await fixture();
    f.ctx.podRepo.update(f.podId, { lastValidationResult: f.result });
    f.ctx.db.pragma('query_only=ON');
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.selection).toEqual({
      expectedGeneration: f.pod().lifecycleGeneration,
      expectedResultHash: checkpointHash(f.result),
    });
    expect(inspection.selection).toEqual(f.recovery.selection(f.podId));
    expect(inspection.infrastructure).toMatchObject({
      state: 'reported',
      needs: [{ id: f.report.id, needs: f.report.payload.needs }],
    });
    expect(f.ctx.podRepo.hasInfrastructureBlocker?.(f.podId)).toBe(true);
    expect(f.ctx.escalationRepo.getOrThrow(f.report.id)).toEqual(f.originalReport);
  });

  it('does not present old-generation reports as current needs or invent selection for null result', async () => {
    const f = await fixture();
    f.ctx.db
      .prepare('UPDATE escalations SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...f.report.payload, lifecycleGeneration: 0 }), f.report.id);
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.selection).toBeNull();
    expect(inspection.infrastructure).toMatchObject({ state: 'none_recorded', needs: [] });
    expect(inspection.checks[0]?.state).toBe('blocked');
  });

  it.each([
    'active',
    'unknown',
  ] as const)('reports %s worker ownership without settling it', async (kind) => {
    const f = await fixture();
    const tasks = f.ctx.podRepo.taskExecutions;
    const pod = f.pod();
    if (!tasks || !pod.finalization) throw new Error('Missing worker fixture');
    const id = tasks.beginRun(f.podId, pod.lifecycleGeneration, pod.finalization.cycle, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
      resource: { containerId: f.containerId, executionTarget: pod.executionTarget },
    });
    if (kind === 'unknown') tasks.retainUnverifiedRun(id);
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.checks).toContainEqual(
      expect.objectContaining({
        id: 'worker_settlement',
        state: 'blocked',
        code: 'TASK_EXECUTION_UNSETTLED',
      }),
    );
    expect(inspection.infrastructure).toMatchObject({
      state: 'reported',
      needs: [{ id: f.report.id, needs: f.report.payload.needs }],
    });
    expect(tasks.hasActiveRun(f.podId)).toBe(true);
    expect(tasks.hasUnverifiedTermination(f.podId)).toBe(kind === 'unknown');
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('shows unread guidance even when an earlier policy refusal hides it', async () => {
    const f = await fixture();
    const guards = createCompletionGuards({ podRepo: f.ctx.podRepo, nudgeRepo: f.ctx.nudgeRepo });
    vi.mocked(f.deps.assertGuidanceCollected).mockImplementation(guards.assertGuidanceCollected);
    f.ctx.nudgeRepo.queue(f.podId, 'Read and apply this saved human guidance');
    f.ctx.podRepo.update(f.podId, { worktreeCompromised: true });
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.checks).toContainEqual(
      expect.objectContaining({
        id: 'human_guidance',
        state: 'blocked',
        code: 'UNCOLLECTED_HUMAN_GUIDANCE',
      }),
    );
    expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(true);
  });

  it('bounds displayed needs without changing original reports or their selection hash meaning', async () => {
    const f = await fixture();
    for (let index = 0; index < 24; index++)
      f.ctx.escalationRepo.insert({
        ...f.report,
        id: `additional-${index}`,
        payload: { ...f.report.payload, phase: 'p'.repeat(300), needs: 'n'.repeat(2000) },
      });
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.infrastructure.truncated).toBe(true);
    expect(inspection.infrastructure.needs).toHaveLength(20);
    expect(inspection.infrastructure.needs.some((need) => need.truncated)).toBe(true);
    expect(inspection.infrastructure.needs.every((need) => (need.needs?.length ?? 0) <= 1024)).toBe(
      true,
    );
    expect(inspection.selection?.expectedResultHash).toBe(
      f.recovery.selection(f.podId)?.expectedResultHash,
    );
    expect(f.ctx.escalationRepo.getOrThrow('additional-0').payload).toMatchObject({
      needs: 'n'.repeat(2000),
    });
  });

  it.each([
    'agent_settled_at',
    'source_preserved_at',
  ])('shows reports without fabricating missing %s or selection evidence', async (column) => {
    const f = await fixture();
    f.ctx.db.prepare(`UPDATE pod_finalizations SET ${column}=NULL WHERE pod_id=?`).run(f.podId);
    f.ctx.db.pragma('query_only=ON');
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.selection).toBeNull();
    expect(
      column === 'agent_settled_at'
        ? inspection.prerequisites.workerSettlementRecorded
        : inspection.prerequisites.sourcePreservationRecorded,
    ).toBe(false);
    expect(inspection.infrastructure).toMatchObject({
      state: 'reported',
      needs: [{ id: f.report.id, needs: f.report.payload.needs }],
    });
    expect(f.ctx.escalationRepo.getOrThrow(f.report.id)).toEqual(f.originalReport);
  });

  it('exposes pending decisions without answering or clearing them', async () => {
    const f = await fixture();
    vi.spyOn(f.ctx.podRepo, 'hasUnansweredDecision').mockReturnValue(true);
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.prerequisites.pendingDecision).toBe(true);
    expect(f.ctx.podRepo.hasUnansweredDecision?.(f.podId)).toBe(true);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('observes retained operation custody without replaying or activating preparation', async () => {
    const f = await fixture();
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    const before = f.recovery.list(f.podId);
    const inspection = f.recovery.inspect(f.podId);
    expect(inspection.status).toBe('blocked');
    expect(inspection.checks).toContainEqual(
      expect.objectContaining({
        id: 'retained_custody',
        state: 'blocked',
        code: 'CHECKPOINT_RECOVERY_IN_PROGRESS',
      }),
    );
    expect(f.recovery.list(f.podId)).toEqual(before);
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('propagates a diagnostic report storage failure rather than hiding reported needs', async () => {
    const f = await fixture();
    const repo = f.ctx.podRepo.retainedCheckpoints;
    if (!repo) throw new Error('Missing checkpoint repository');
    const error = new Error('Diagnostic report query failed');
    vi.spyOn(repo, 'infrastructureNeeds').mockImplementation(() => {
      throw error;
    });
    expect(() => f.recovery.inspect(f.podId)).toThrow(error);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('propagates unexpected storage and configuration errors rather than claiming no blocker', async () => {
    const f = await fixture();
    for (const error of [
      new Error('Storage unavailable'),
      new AutopodError('Storage unavailable', 'UNAVAILABLE', 503),
    ]) {
      vi.mocked(f.deps.isGoal).mockImplementationOnce(() => {
        throw error;
      });
      expect(() => f.recovery.inspect(f.podId)).toThrow(error);
    }
  });
});

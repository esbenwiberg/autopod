import type { Pod, PodGoal, PodStatus } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createTestContext, logger } from '../test-utils/mock-helpers.js';
import { createCompletionHumanGate } from './completion-human-gate.js';
import { createCompletionWorkflow } from './completion-workflow.js';
import { reconcileLocalSessions } from './local-reconciler.js';
import type { PodUpdates } from './pod-repository.js';
import { reconcileSandboxSessions } from './reconciler.js';
import { validateTransition } from './state-machine.js';
import { createValidationRepository } from './validation-repository.js';
import { createWorkspaceFences } from './workspace-fences.js';

function fixture({
  target = 'local',
  recordRun = true,
  bindResource = true,
  runtime = 'claude',
}: {
  runtime?: Pod['runtime'];
  target?: Pod['executionTarget'];
  recordRun?: boolean;
  bindResource?: boolean;
} = {}) {
  const ctx = createTestContext();
  const repo = ctx.podRepo;
  repo.insert({
    id: 'blocked-restart',
    profileName: 'test-profile',
    task: 'Retain infrastructure evidence',
    status: 'running',
    model: 'opus',
    runtime,
    executionTarget: target,
    branch: 'blocked-restart',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('blocked-restart', {
    containerId: 'original-container',
    worktreePath: '/retained/source',
    validationAttempts: 2,
    recoveryCount: 2,
  });
  let pod = repo.getOrThrow('blocked-restart');
  repo.completionJournal?.begin(pod);
  pod = repo.getOrThrow(pod.id);
  const cycle = pod.finalization?.cycle;
  if (cycle === undefined || !repo.taskExecutions) throw new Error('Missing execution fixture');
  const runId = recordRun
    ? repo.taskExecutions.beginRun(pod.id, pod.lifecycleGeneration, cycle, {
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: null,
        ...(bindResource && {
          resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
        }),
      })
    : '';
  ctx.escalationRepo.insert({
    id: 'infrastructure-report',
    podId: pod.id,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    response: null,
    payload: {
      kind: 'infrastructure',
      lifecycleGeneration: pod.lifecycleGeneration,
      requiresResponse: false,
      owner: 'validation',
      phase: 'build',
      description: 'Configured runner unavailable',
      attempted: ['configured build'],
      needs: 'Repair the qualified runner',
    },
  });
  const preserve = vi.fn(async (_pod: Pod, _reason: string) => {});
  const transition = vi.fn((current: Pod, to: PodStatus, updates?: Partial<PodUpdates>) => {
    validateTransition(current.id, current.status, to);
    repo.update(current.id, { status: to, ...updates });
    return repo.getOrThrow(current.id);
  });
  const { ownsArtifactCompletion } = createWorkspaceFences({
    podRepo: repo,
    nudgeRepo: ctx.nudgeRepo,
    logger,
    eventBus: ctx.eventBus,
    emitActivityStatus: vi.fn(),
    emitActivityError: vi.fn(),
    assertApprovalCurrent: vi.fn(),
    assertGuidanceCollected: vi.fn(),
    transition,
  });
  const gate = createCompletionHumanGate({
    podRepo: repo,
    escalationRepo: ctx.escalationRepo,
    nudgeRepo: ctx.nudgeRepo,
    preservePodWorkspace: preserve,
    ownsArtifactCompletion,
    transition,
    logger,
    emitActivityStatus: vi.fn(),
  });
  const prepareSourceForCompletion = vi.fn(async () => null);
  const finalizeArtifactPod = vi.fn(async () => {});
  const applyCompletionDecision = vi.fn(async () => {});
  const completion = createCompletionWorkflow(
    {},
    {
      podRepo: repo,
      holdCompletionForHumanWork: gate.holdCompletionForHumanWork,
      artifactCompletionRuns: new Map(),
      prepareSourceForCompletion,
      finalizeArtifactPod,
      applyCompletionDecision,
    },
  );
  const enqueueSession = vi.fn();
  const cleanupPodResources = vi.fn(async () => {});
  const reconcileInfrastructureBlocker = vi.fn((id: string) =>
    completion.reconcileInfrastructureBlocker(id),
  );
  const deps = {
    podRepo: repo,
    eventBus: ctx.eventBus,
    containerManager: ctx.containerManager,
    enqueueSession,
    cleanupPodResources,
    validationRepo: createValidationRepository(ctx.db),
    reconcileInfrastructureBlocker,
    logger,
  };
  return {
    ...ctx,
    pod,
    runId,
    cycle,
    preserve,
    transition,
    completion,
    prepareSourceForCompletion,
    finalizeArtifactPod,
    applyCompletionDecision,
    enqueueSession,
    cleanupPodResources,
    reconcileInfrastructureBlocker,
    deps,
    async reconcile(trigger: 'restart' | 'wake' = 'restart') {
      if (target === 'local') return reconcileLocalSessions({ ...deps, trigger });
      await reconcileSandboxSessions({
        ...deps,
        sandboxContainerManager: ctx.containerManager as unknown as SandboxContainerManager,
        preserveWorkspace: vi.fn(async () => {}),
        quiesceSandboxAgent: vi.fn(async () => {}),
        suspendSandbox: vi.fn(async () => {}),
      });
    },
    expectNoDispatch() {
      expect(enqueueSession).not.toHaveBeenCalled();
      expect(cleanupPodResources).not.toHaveBeenCalled();
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
      expect(ctx.containerManager.start).not.toHaveBeenCalled();
      expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      expect(prepareSourceForCompletion).not.toHaveBeenCalled();
      expect(finalizeArtifactPod).not.toHaveBeenCalled();
      expect(applyCompletionDecision).not.toHaveBeenCalled();
      expect(ctx.escalationRepo.getOrThrow('infrastructure-report').response).toBeNull();
    },
  };
}

describe('infrastructure blocker restart reconciliation', () => {
  it('re-evaluates a human reply that arrives while question preservation is coalesced', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const question = {
        id: 'question',
        podId: f.pod.id,
        type: 'ask_human' as const,
        timestamp: new Date().toISOString(),
        response: null,
        payload: { question: 'Which scope?' },
      };
      f.escalationRepo.insert(question);
      f.podRepo.update(f.pod.id, { status: 'awaiting_input', pendingEscalation: question });
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed');
      f.preserve.mockImplementationOnce(async () => {
        await gate;
      });
      const first = f.completion.reconcileInfrastructureBlocker(f.pod.id);
      await vi.waitFor(() => expect(f.preserve).toHaveBeenCalledOnce());
      f.escalationRepo.update('question', {
        response: 'Proceed',
        respondedBy: 'human',
        respondedAt: new Date().toISOString(),
      });
      f.podRepo.update(f.pod.id, { status: 'running', pendingEscalation: null });
      f.nudgeRepo.queue(f.pod.id, 'Proceed');
      const reply = f.completion.reconcileInfrastructureBlocker(f.pod.id);
      release();
      await Promise.all([first, reply]);
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        pendingEscalation: null,
        finalization: { sourcePreservedAt: expect.any(String) },
      });
      expect(f.escalationRepo.getOrThrow('question').response?.response).toBe('Proceed');
      expect(f.nudgeRepo.hasPending(f.pod.id)).toBe(true);
      f.expectNoDispatch();
    } finally {
      release();
      f.db.close();
    }
  });
  it('coalesces terminal, pause and restart preservation for the same settled resource', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.preserve.mockImplementation(async () => {
      await gate;
    });
    f.podRepo.taskExecutions?.finishRun(f.runId, 'paused');
    const first = f.completion.reconcileInfrastructureBlocker(f.pod.id);
    const second = f.completion.reconcileInfrastructureBlocker(f.pod.id);
    try {
      await vi.waitFor(() => expect(f.preserve).toHaveBeenCalledOnce());
      expect(f.podRepo.getOrThrow(f.pod.id).finalization?.sourcePreservedAt).toBeNull();
    } finally {
      release();
    }
    try {
      await Promise.all([first, second]);
      expect(f.preserve).toHaveBeenCalledOnce();
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        finalization: { sourcePreservedAt: expect.any(String) },
      });
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });
  it.each([
    true,
    false,
  ])('retains native Goal stop evidence before infrastructure preservation; stopped=%s', async (executionStopped) => {
    const f = fixture({ runtime: 'codex' });
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'failed', 'infrastructure');
      const goal: PodGoal = {
        podId: f.pod.id,
        objective: 'Retain blocked Goal work',
        state: 'paused',
        revision: 1,
        runtime: 'codex',
        fence: { generation: f.pod.lifecycleGeneration, attemptId: f.runId },
        nativeSessionId: 'native',
        nativeStatus: 'paused',
        executionStopped,
        controlIntent: null,
        observedTokens: 0,
        observedSeconds: 0,
        reason: null,
        createdAt: 'now',
        updatedAt: 'now',
      };
      await reconcileLocalSessions({ ...f.deps, readNativeGoal: () => goal });
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: executionStopped ? 'failed' : 'running',
        finalization: { sourcePreservedAt: executionStopped ? expect.any(String) : null },
      });
      expect(f.preserve).toHaveBeenCalledTimes(executionStopped ? 1 : 0);
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });
  it('retains infrastructure ownership when its Goal recovery read fails', async () => {
    const f = fixture({ runtime: 'codex' });
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'failed', 'infrastructure');
      await reconcileLocalSessions({
        ...f.deps,
        readNativeGoal: () => {
          throw new Error('Goal custody unavailable');
        },
      });
      expect(f.podRepo.getOrThrow(f.pod.id).status).toBe('running');
      expect(f.preserve).not.toHaveBeenCalled();
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });
  it('parks a verified settled worker through source preservation instead of leaving it running', async () => {
    const f = fixture();
    try {
      f.podRepo.completionJournal?.settle(f.pod, 'Checks are incomplete');
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      const result = await reconcileLocalSessions(f.deps);
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        containerId: f.pod.containerId,
        worktreePath: f.pod.worktreePath,
        lifecycleGeneration: f.pod.lifecycleGeneration,
        validationAttempts: 2,
        recoveryCount: 2,
        pendingEscalation: null,
        failureReason: expect.stringContaining('Infrastructure blocked during build'),
        finalization: { cycle: f.cycle, sourcePreservedAt: expect.any(String) },
      });
      expect(result.skipped).toContain(f.pod.id);
      expect(f.preserve).toHaveBeenCalledOnce();
      expect(f.reconcileInfrastructureBlocker).toHaveBeenCalledOnce();
      expect(f.enqueueSession).not.toHaveBeenCalled();
      expect(f.cleanupPodResources).not.toHaveBeenCalled();
      expect(f.containerManager.kill).not.toHaveBeenCalled();
      expect(f.prepareSourceForCompletion).not.toHaveBeenCalled();
      expect(f.finalizeArtifactPod).not.toHaveBeenCalled();
      expect(f.applyCompletionDecision).not.toHaveBeenCalled();
      expect(f.escalationRepo.getOrThrow('infrastructure-report').response).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it.each([
    'local',
    'sandbox',
  ] as const)('parks a verified %s failure without requiring an agent complete event', async (target) => {
    const f = fixture({ target });
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'failed', 'infrastructure');
      await f.reconcile('wake');
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        containerId: f.pod.containerId,
        worktreePath: f.pod.worktreePath,
        lifecycleGeneration: f.pod.lifecycleGeneration,
        validationAttempts: 2,
        recoveryCount: 2,
        lastRecoveryTrigger: target === 'local' ? 'wake' : 'restart',
        failureReason: expect.stringContaining('Infrastructure blocked during build'),
        finalization: {
          agentSettledAt: expect.any(String),
          sourcePreservedAt: expect.any(String),
        },
      });
      expect(f.preserve).toHaveBeenCalledOnce();
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });

  it.each([
    'local',
    'sandbox',
  ] as const)('does not infer %s termination from a complete event, missing run or old custody', async (target) => {
    for (const evidence of [
      'active',
      'unverified',
      'missing',
      'old-cycle',
      'wrong-resource',
      'legacy-binding',
    ] as const) {
      const f = fixture({
        target,
        recordRun: evidence !== 'missing',
        bindResource: evidence !== 'legacy-binding',
      });
      try {
        f.podRepo.completionJournal?.settle(f.pod, 'Complete event is not native exit proof');
        if (evidence === 'unverified') f.podRepo.taskExecutions?.retainUnverifiedRun(f.runId);
        else if (!['active', 'missing'].includes(evidence)) {
          f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
        }
        if (evidence === 'old-cycle') {
          f.podRepo.completionJournal?.begin(f.podRepo.getOrThrow(f.pod.id));
        }
        if (evidence === 'wrong-resource') {
          f.podRepo.update(f.pod.id, { containerId: 'replacement-resource' });
        }
        const before = f.db.prepare('SELECT * FROM task_agent_runs WHERE id = ?').get(f.runId);
        await f.reconcile();
        expect(f.podRepo.getOrThrow(f.pod.id).status, evidence).toBe('running');
        expect(f.preserve, evidence).not.toHaveBeenCalled();
        expect(f.transition, evidence).not.toHaveBeenCalled();
        expect(f.db.prepare('SELECT * FROM task_agent_runs WHERE id = ?').get(f.runId)).toEqual(
          before,
        );
        f.expectNoDispatch();
      } finally {
        f.db.close();
      }
    }
  });

  it('requires the exact lifecycle, cycle and backend in the positive ledger read', () => {
    const f = fixture();
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      const ledger = f.podRepo.taskExecutions;
      expect(ledger?.hasSettledRun?.(f.pod, f.cycle)).toBe(true);
      expect(
        ledger?.hasSettledRun?.(
          { ...f.pod, lifecycleGeneration: f.pod.lifecycleGeneration + 1 },
          f.cycle,
        ),
      ).toBe(false);
      expect(ledger?.hasSettledRun?.(f.pod, f.cycle + 1)).toBe(false);
      expect(ledger?.hasSettledRun?.({ ...f.pod, executionTarget: 'sandbox' }, f.cycle)).toBe(
        false,
      );
      expect(ledger?.hasSettledRun?.({ ...f.pod, containerId: null }, f.cycle)).toBe(false);
    } finally {
      f.db.close();
    }
  });

  it.each([
    'local',
    'sandbox',
  ] as const)('retains %s ownership when reconciliation reads fail instead of taking a generic terminal fallback', async (target) => {
    const f = fixture({ target });
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      f.reconcileInfrastructureBlocker.mockRejectedValueOnce(
        new Error('Settlement storage unavailable'),
      );
      await f.reconcile();
      expect(f.podRepo.getOrThrow(f.pod.id).status).toBe('running');
      expect(f.preserve).not.toHaveBeenCalled();
      expect(f.transition).not.toHaveBeenCalled();
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });

  it.each([
    'local',
    'sandbox',
  ] as const)('keeps a real unanswered %s decision ahead of the infrastructure report', async (target) => {
    const f = fixture({ target });
    try {
      const question = {
        id: 'owner-decision',
        podId: f.pod.id,
        type: 'ask_human' as const,
        timestamp: new Date().toISOString(),
        payload: { question: 'Which scope?', requiresResponse: true },
        response: null,
      };
      f.escalationRepo.insert(question);
      f.podRepo.update(f.pod.id, { status: 'awaiting_input', pendingEscalation: question });
      f.podRepo.completionJournal?.settle(f.podRepo.getOrThrow(f.pod.id));
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      await f.reconcile();
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'awaiting_input',
        pendingEscalation: question,
        finalization: { pendingDecisionId: question.id },
      });
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.escalationRepo.getOrThrow(question.id).response).toBeNull();
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });

  it('does not finalize a replacement lifecycle after awaited preservation', async () => {
    const f = fixture();
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      f.preserve.mockImplementationOnce(async () => {
        f.podRepo.incrementLifecycleGeneration(f.pod.id);
      });
      await f.reconcile();
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'running',
        lifecycleGeneration: f.pod.lifecycleGeneration + 1,
      });
      expect(f.transition).not.toHaveBeenCalled();
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });

  it.each([
    'local',
    'sandbox',
  ] as const)('retains original %s resources and reports capture failure after verified settlement', async (target) => {
    const f = fixture({ target });
    try {
      f.podRepo.taskExecutions?.finishRun(f.runId, 'completed', null);
      f.preserve.mockRejectedValueOnce(new Error('Checkpoint unavailable'));
      await f.reconcile();
      expect(f.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        containerId: f.pod.containerId,
        worktreePath: f.pod.worktreePath,
        validationAttempts: 2,
        recoveryCount: 2,
        failureReason: expect.stringContaining(
          'Workspace preservation failed: Checkpoint unavailable',
        ),
        finalization: { sourcePreservedAt: null },
      });
      f.expectNoDispatch();
    } finally {
      f.db.close();
    }
  });
});

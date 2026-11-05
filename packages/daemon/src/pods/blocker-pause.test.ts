import { createEscalationMcpServer, PendingRequests } from '@autopod/escalation-mcp';
import { AutopodError, type EscalationRequest } from '@autopod/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import {
  completeEvent,
  createMockRuntime,
  createTestContext,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { isBlockingEscalation, persistEscalation } from './escalation-coordinator.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';

it.each([
  { hasQuestion: false, threshold: 3 },
  { hasQuestion: false, threshold: 10 },
  { hasQuestion: true, threshold: 3 },
  { hasQuestion: false, threshold: 10, completion: 'blocked by the execution environment' },
  { hasQuestion: false, threshold: 3, completion: 'blocked by the execution environment' },
  { hasQuestion: false, threshold: 10, budget: 'soft' as const },
  { hasQuestion: false, threshold: 10, budget: 'hard' as const },
  { hasQuestion: false, threshold: 3, unverified: true },
  { hasQuestion: false, threshold: 10, providerLimit: true },
])('holds infrastructure after settlement without displacing a question (%s)', async ({
  hasQuestion,
  threshold,
  completion = 'Finished',
  budget,
  unverified,
  providerLimit,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = createTestContext({
    runtime: createMockRuntime({
      spawn: vi.fn(async function* () {
        yield statusEvent('Working');
        await gate;
        if (unverified)
          yield {
            type: 'error' as const,
            timestamp: new Date().toISOString(),
            message: 'Termination unconfirmed',
            fatal: true,
            executionTermination: 'unverified' as const,
          };
        else if (providerLimit)
          yield {
            type: 'error' as const,
            timestamp: new Date().toISOString(),
            message: 'Provider quota exhausted',
            fatal: true,
            classification: {
              category: 'quota_exhausted' as const,
              definitive: true,
              sanitizedMessage: 'Provider quota exhausted',
            },
          };
        else
          yield {
            ...completeEvent(completion),
            ...(budget ? { totalInputTokens: 20, totalOutputTokens: 1 } : {}),
          };
      }),
    }),
  });
  ctx.db.prepare('UPDATE profiles SET escalation_config = ? WHERE name = ?').run(
    JSON.stringify({
      ...ctx.profileStore.get('test-profile').escalation,
      autoPauseAfter: threshold,
    }),
    'test-profile',
  );
  if (budget) {
    ctx.db
      .prepare('UPDATE profiles SET token_budget_policy = ? WHERE name = ?')
      .run(budget, 'test-profile');
    expect(ctx.profileStore.get('test-profile').tokenBudgetPolicy).toBe(budget);
  }
  if (unverified)
    vi.mocked(ctx.runtime.suspend).mockRejectedValue(new Error('Suspension unconfirmed'));
  const waiters = new Map<string, PendingRequests>();
  ctx.deps.pendingRequestsByPod = waiters;
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    {
      profileName: 'test-profile',
      task: 'Check blocker lifecycle',
      ...(budget ? { tokenBudget: 10 } : {}),
    },
    'operator',
  );
  const pending = new PendingRequests();
  waiters.set(pod.id, pending);
  const bridge = createSessionBridge({
    ...ctx.deps,
    podManager: manager,
    pendingRequestsByPod: waiters,
  });
  const { server } = createEscalationMcpServer({
    podId: pod.id,
    bridge,
    pendingRequests: pending,
  });
  const client = new Client({ name: 'blocker-threshold-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const process = manager.processPod(pod.id);
  const report = () =>
    client.callTool({
      name: 'report_blocker',
      arguments: {
        description: 'Optional source unavailable',
        attempted: ['Bounded request'],
        needs: 'Can proceed with remaining evidence',
      },
    });
  try {
    await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('running'));
    for (let index = 0; index < 2; index++)
      bridge.createEscalation({
        id: `ai-${index}`,
        podId: pod.id,
        type: 'ask_ai',
        timestamp: new Date().toISOString(),
        payload: { question: 'Technical advice' },
        response: { respondedBy: 'ai', response: 'Advice only' },
      });
    if (hasQuestion)
      bridge.createEscalation({
        id: 'real-question',
        podId: pod.id,
        type: 'ask_human',
        timestamp: new Date().toISOString(),
        payload: { question: 'Choose product scope?' },
        response: null,
      });
    const update = ctx.podRepo.update;
    const fault = vi.spyOn(ctx.podRepo, 'update').mockImplementation((id, changes) => {
      if (changes.failureReason?.startsWith('Infrastructure blocked'))
        throw new Error('injected report write fault');
      return update(id, changes);
    });
    try {
      expect(() =>
        bridge.createEscalation({
          id: 'rolled-back-report',
          podId: pod.id,
          type: 'report_blocker',
          timestamp: new Date().toISOString(),
          payload: {
            kind: 'infrastructure',
            requiresResponse: false,
            description: 'Runner unavailable',
            attempted: [],
            needs: 'Repair',
          },
          response: null,
        }),
      ).toThrow('injected report write fault');
      expect(bridge.getAutoPauseCount(pod.id)).toBe(2);
      expect(
        ctx.escalationRepo.listBySession(pod.id).some((entry) => entry.id === 'rolled-back-report'),
      ).toBe(false);
      expect(ctx.runtime.suspend).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
    }
    for (let count = 1; count <= 4; count++) {
      const result = await report();
      expect(JSON.stringify(result)).toContain('No human answer');
      expect(manager.getSession(pod.id).status).toBe(hasQuestion ? 'awaiting_input' : 'running');
      expect(manager.getSession(pod.id).pendingEscalation?.id ?? null).toBe(
        hasQuestion ? 'real-question' : null,
      );
      expect(bridge.getAutoPauseCount(pod.id)).toBe(count + 2);
      // Recreated bridges use durable records, not a process-local or AI-only counter.
      const reopened = createSessionBridge({
        ...ctx.deps,
        podManager: manager,
        pendingRequestsByPod: waiters,
      });
      expect(reopened.getAutoPauseCount(pod.id)).toBe(count + 2);
      expect(bridge.getAiEscalationCount(pod.id)).toBe(2);
      if (!hasQuestion)
        bridge.reportProgress(pod.id, 'research', 'Preserving available work', 1, 2);
    }
    expect(ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.runtime.suspend).toHaveBeenCalledTimes(!hasQuestion && threshold === 3 ? 1 : 0);
  } finally {
    pending.cancelAll();
    release();
    await process;
    if (unverified) {
      await manager.reconcileInfrastructureBlocker(pod.id);
      expect(ctx.podRepo.taskExecutions?.hasUnverifiedTermination(pod.id)).toBe(true);
      expect(manager.getSession(pod.id)).toMatchObject({
        status: 'running',
        finalization: { sourcePreservedAt: null },
      });
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    } else {
      if (!hasQuestion && threshold === 3)
        await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('failed'));
      expect(manager.getSession(pod.id)).toMatchObject({
        status: hasQuestion ? 'awaiting_input' : 'failed',
        pendingEscalation: hasQuestion ? expect.objectContaining({ id: 'real-question' }) : null,
        failureReason: expect.stringContaining('Infrastructure blocked:'),
        finalization: { sourcePreservedAt: expect.any(String) },
      });
      if (budget) {
        expect(manager.getSession(pod.id)).toMatchObject({
          tokenBudget: 10,
          budgetExtensionsUsed: 0,
          inputTokens: 20,
          outputTokens: 1,
        });
        expect(ctx.podRepo.taskExecutions?.snapshot(pod.id).recordedTotalTokens).toBe(21);
      }
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      if (!hasQuestion) {
        await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
          code: 'INFRASTRUCTURE_BLOCKED',
        });
        await expect(
          manager.sendMessage(pod.id, 'ok', { type: 'human', id: 'owner' }),
        ).rejects.toMatchObject({ code: 'INFRASTRUCTURE_BLOCKED' });
        const restarted = createPodManager(ctx.deps);
        await expect(restarted.resumePod(pod.id)).rejects.toMatchObject({
          code: 'INFRASTRUCTURE_BLOCKED',
        });
        expect(ctx.runtime.spawn).toHaveBeenCalledTimes(1);
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      }
      if (hasQuestion) {
        await manager.sendMessage(pod.id, 'Choose the narrower product scope', {
          type: 'human',
          userId: 'operator',
          displayName: 'Operator',
        });
        expect(ctx.escalationRepo.getOrThrow('real-question').response?.response).toBe(
          'Choose the narrower product scope',
        );
        expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(true);
        expect(manager.getSession(pod.id)).toMatchObject({
          status: 'failed',
          pendingEscalation: null,
          finalization: { sourcePreservedAt: expect.any(String) },
        });
        expect(manager.getSession(pod.id).failureReason).not.toContain('Use Rework');
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        expect(ctx.runtime.spawn).toHaveBeenCalledTimes(1);
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      }
    }
    await client.close();
    await server.close();
    ctx.db.close();
  }
});

it.each(
  (['rejection', 'message', 'override'] as const).flatMap((route) =>
    (['fatal', 'throw', 'unverified', 'throw-unverified'] as const).map((mode) => ({
      route,
      mode,
    })),
  ),
)('preserves reported feedback after %j termination', async ({ route, mode }) => {
  let podId = '';
  let bridge!: ReturnType<typeof createSessionBridge>;
  const uncertain = mode === 'unverified' || mode === 'throw-unverified';
  const throwing = mode === 'throw' || mode === 'throw-unverified';
  const failure =
    mode === 'throw-unverified'
      ? new AutopodError('Native exit remains unknown', 'EXEC_EXIT_UNVERIFIED', 409)
      : new Error('Observed native feedback exit failed');
  const ctx = createTestContext({
    runtime: createMockRuntime({
      resume: vi.fn(async function* () {
        yield statusEvent('Feedback running');
        bridge.createEscalation({
          id: 'feedback-infra',
          podId,
          type: 'report_blocker',
          timestamp: new Date().toISOString(),
          response: null,
          payload: {
            kind: 'infrastructure',
            requiresResponse: false,
            description: 'Runner unavailable',
            attempted: [],
            needs: 'Qualified execution',
          },
        });
        if (throwing) throw failure;
        yield {
          type: 'error' as const,
          timestamp: new Date().toISOString(),
          message: 'Observed native feedback exit',
          fatal: true,
          ...(mode === 'unverified' ? { executionTermination: 'unverified' as const } : {}),
        };
      }),
    }),
  });
  try {
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Feedback custody' },
      'operator',
    );
    podId = pod.id;
    ctx.podRepo.update(podId, {
      status:
        route === 'rejection' ? 'validated' : route === 'override' ? 'awaiting_input' : 'paused',
      pauseReason: route === 'message' ? 'manual' : null,
      containerId: 'container-123',
      worktreePath: '/tmp/worktrees/test',
      claudeSessionId: 'native-session',
    });
    if (route === 'override') {
      const decision: EscalationRequest = {
        id: 'guidance',
        podId,
        type: 'validation_override',
        timestamp: new Date().toISOString(),
        response: null,
        payload: {
          findings: [
            {
              id: 'review:bounded',
              source: 'task_review',
              description: 'Address the bounded defect',
            },
          ],
          attempt: 1,
          maxAttempts: 3,
        },
      };
      ctx.escalationRepo.insert(decision);
      ctx.podRepo.update(podId, { pendingEscalation: decision });
    }
    bridge = createSessionBridge({ ...ctx.deps, podManager: manager });
    const operation =
      route === 'rejection'
        ? manager.rejectSession(podId, 'Address feedback')
        : manager.sendMessage(podId, 'Continue bounded work', {
            type: 'human',
            userId: 'operator',
          });
    if (throwing) await expect(operation).rejects.toBe(failure);
    else await operation;
    expect(manager.getSession(podId)).toMatchObject({
      status: uncertain ? 'running' : 'failed',
      finalization: { sourcePreservedAt: uncertain ? null : expect.any(String) },
    });
    expect(ctx.podRepo.taskExecutions?.hasUnverifiedTermination(podId)).toBe(uncertain);
    expect(ctx.runtime.resume).toHaveBeenCalledOnce();
    expect(ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(ctx.escalationRepo.getOrThrow('feedback-infra').response).toBeNull();
  } finally {
    ctx.db.close();
  }
});

it.each(
  (['host_fetch', 'host_push', 'override_dismiss', 'override_guidance'] as const).flatMap(
    (source) =>
      (['settled', 'unverified'] as const).map((termination) => ({ source, termination })),
  ),
)('routes an answered daemon decision through real ownership: %j', async ({
  source,
  termination,
}) => {
  const ctx = createTestContext();
  ctx.deps.githubAuth = {
    resolveCredential: vi.fn(async () => ({ token: 'synthetic-git-key', username: 'synthetic' })),
    getStatus: vi.fn(async () => ({
      available: true as const,
      login: 'synthetic',
      setup: 'synthetic',
    })),
  };
  try {
    const manager = createPodManager(ctx.deps);
    const created = manager.createSession(
      { profileName: 'test-profile', task: 'Retain answered daemon decision custody' },
      'operator',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    ctx.podRepo.update(created.id, {
      status: 'running',
      containerId: 'container-123',
      worktreePath: '/tmp/worktrees/test',
      validationAttempts: 2,
      validationOverrides: [
        {
          findingId: 'existing',
          description: 'Prior decision',
          action: 'dismiss',
          reason: 'Previously authorized',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    ctx.podRepo.completionJournal?.begin(ctx.podRepo.getOrThrow(created.id));
    const pod = ctx.podRepo.getOrThrow(created.id);
    const cycle = pod.finalization?.cycle;
    const ledger = ctx.podRepo.taskExecutions;
    if (!ledger || cycle === undefined) throw new Error('Missing bound execution fixture');
    const run = ledger.beginRun(pod.id, pod.lifecycleGeneration, cycle, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
      resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
    });
    if (termination === 'unverified') ledger.retainUnverifiedRun(run);
    else ledger.finishRun(run, 'completed', null);
    const request: EscalationRequest = {
      id: 'daemon-decision',
      podId: pod.id,
      type:
        source === 'host_fetch' || source === 'host_push'
          ? 'request_credential'
          : 'validation_override',
      timestamp: new Date().toISOString(),
      response: null,
      payload:
        source === 'host_fetch' || source === 'host_push'
          ? { service: 'github', reason: 'Daemon identity needs repair', source }
          : {
              findings: [
                {
                  id: 'review:bounded',
                  source: 'task_review',
                  description: 'Address the bounded defect',
                },
              ],
              attempt: 2,
              maxAttempts: 3,
            },
    };
    persistEscalation(ctx.podRepo, ctx.escalationRepo, request, () => {
      ctx.podRepo.update(pod.id, { status: 'awaiting_input', pendingEscalation: request });
    });
    createSessionBridge({ ...ctx.deps, podManager: manager }).createEscalation({
      id: 'host-reply-infra',
      podId: pod.id,
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      response: null,
      payload: {
        kind: 'infrastructure',
        requiresResponse: false,
        description: 'Qualified runner required',
        attempted: [],
        needs: 'Repair execution',
      },
    });
    const queued = [...ctx.enqueuedSessions];
    const actor = { type: 'human' as const, userId: 'decision-owner' };
    const message =
      source === 'override_dismiss'
        ? 'dismiss all'
        : source === 'override_guidance'
          ? 'Keep the protections and fix the finding'
          : 'repaired';
    await manager.sendMessage(pod.id, message, actor);
    expect(manager.getSession(pod.id)).toMatchObject({
      status: termination === 'settled' ? 'failed' : 'running',
      pendingEscalation: null,
      containerId: pod.containerId,
      worktreePath: pod.worktreePath,
      validationAttempts: 2,
      validationOverrides: pod.validationOverrides,
      budgetExtensionsUsed: pod.budgetExtensionsUsed,
      lifecycleGeneration: pod.lifecycleGeneration,
      finalization: { sourcePreservedAt: termination === 'settled' ? expect.any(String) : null },
    });
    expect(ledger.hasUnverifiedTermination(pod.id)).toBe(termination === 'unverified');
    expect(ctx.escalationRepo.getOrThrow(request.id).response).toMatchObject({
      actor,
      response:
        source === 'host_push'
          ? 'daemon_auth_repaired'
          : source === 'host_fetch'
            ? 'credential_repaired'
            : message,
    });
    expect(ctx.escalationRepo.getOrThrow('host-reply-infra').response).toBeNull();
    expect(ctx.enqueuedSessions).toEqual(queued);
    expect(ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(ctx.runtime.resume).not.toHaveBeenCalled();
    expect(ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(ctx.containerManager.stop).not.toHaveBeenCalled();
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
  } finally {
    ctx.db.close();
  }
});
it('keeps legacy blockers and explicit human questions blocking', () => {
  const base = { id: 'legacy', podId: 'pod', timestamp: new Date().toISOString(), response: null };
  expect(
    isBlockingEscalation({
      ...base,
      type: 'report_blocker',
      payload: { description: 'Legacy', attempted: [], needs: 'Reply' },
    }),
  ).toBe(true);
  expect(
    isBlockingEscalation({ ...base, type: 'ask_human', payload: { question: 'Choose source' } }),
  ).toBe(true);
});

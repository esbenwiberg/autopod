import type { AgentEvent, ValidationResult } from '@autopod/shared';
/**
 * E2E lifecycle tests for the pod manager.
 *
 * Uses real SQLite (in-memory), real PodManager, real EventBus, and real
 * PodRepository. Infrastructure (container, worktree, runtime, validation)
 * is mocked so we can drive the full state-machine without Docker or a real
 * coding agent.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_PATH, AGENT_SHIM_PATH, createPodManager } from './pods/pod-manager.js';
import {
  completeEvent,
  createFailingValidationResult,
  createMockRuntime,
  createPassingValidationResult,
  createTestContext,
  escalationEvent,
  statusEvent,
} from './test-utils/mock-helpers.js';

// ---------------------------------------------------------------------------
// 1. Happy path -- full lifecycle to completion
// ---------------------------------------------------------------------------

describe('E2E: happy path lifecycle', () => {
  it('creates a pod, processes it, validates, and approves to complete', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Analysing codebase...');
        yield statusEvent('Implementing dark mode...');
        yield completeEvent('Dark mode added');
      }),
    });

    const ctx = createTestContext({ runtime });
    const manager = createPodManager(ctx.deps);

    // -- Create --
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Add dark mode toggle' },
      'user-1',
    );
    expect(pod.status).toBe('queued');

    // -- Process (queued -> provisioning -> running -> validating -> validated) --
    await manager.processPod(pod.id);

    const afterProcess = manager.getSession(pod.id);
    expect(afterProcess.status).toBe('validated');
    expect(afterProcess.containerId).toBe('container-123');
    expect(afterProcess.worktreePath).toBe('/tmp/worktree/abc');
    expect(afterProcess.validationAttempts).toBe(1);

    // Verify infrastructure was wired up
    expect(ctx.containerManager.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.worktreeManager.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.containerManager.writeFile).mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([AGENT_ENV_PATH, AGENT_SHIM_PATH]),
    );
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);

    // -- Approve (validated -> approved -> merging -> complete) --
    await manager.approveSession(pod.id);

    const final = manager.getSession(pod.id);
    expect(final.status).toBe('complete');
    expect(final.completedAt).not.toBeNull();
    expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledTimes(1);
  });

  it('emits the correct event sequence', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Done');
      }),
    });

    const ctx = createTestContext({ runtime });
    const manager = createPodManager(ctx.deps);

    const events: { type: string }[] = [];
    ctx.eventBus.subscribe((e) => events.push(e as { type: string }));

    const pod = manager.createSession({ profileName: 'test-profile', task: 'Add tests' }, 'user-1');
    await manager.processPod(pod.id);
    await manager.approveSession(pod.id);

    const types = events.map((e) => e.type);
    expect(types).toContain('pod.created');
    expect(types).toContain('pod.status_changed');
    expect(types).toContain('pod.agent_activity');
    expect(types).toContain('pod.validation_started');
    expect(types).toContain('pod.validation_completed');
    expect(types).toContain('pod.completed');
  });
});

// ---------------------------------------------------------------------------
// 2. Validation failure + retry -- fails once, passes on second attempt
// ---------------------------------------------------------------------------

describe('E2E: validation failure with retry', () => {
  it('fails validation once, resumes agent with correction, passes on retry', async () => {
    let callCount = 0;

    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Working...');
        yield completeEvent('Initial implementation');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Applying corrections...');
        yield completeEvent('Fixed the build');
      }),
    });

    const validationResultFactory = (config: {
      podId: string;
      attempt: number;
    }): ValidationResult => {
      callCount++;
      if (callCount === 1) {
        return createFailingValidationResult(config.podId, config.attempt);
      }
      return createPassingValidationResult(config.podId, config.attempt);
    };

    const ctx = createTestContext({
      runtime,
      validationResultFactory,
      simulatedReworkChangesSource: true,
    });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Fix the login page' },
      'user-1',
    );

    await manager.processPod(pod.id);

    const result = manager.getSession(pod.id);
    expect(result.status).toBe('validated');
    expect(result.validationAttempts).toBe(2);

    // Runtime was resumed once with correction feedback
    expect(runtime.resume).toHaveBeenCalledTimes(1);
    const resumeArgs = vi.mocked(runtime.resume).mock.calls[0] ?? [];

    expect(resumeArgs[0]).toBe(pod.id); // podId
    expect(resumeArgs[1]).toContain('Validation Failed'); // correction message

    // Validation engine was called twice (fail then pass)
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(2);
  });

  it('records the last validation result on success', async () => {
    let callCount = 0;
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Done');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Fixed');
      }),
    });

    const validationResultFactory = (config: {
      podId: string;
      attempt: number;
    }): ValidationResult => {
      callCount++;
      if (callCount === 1) {
        return createFailingValidationResult(config.podId, config.attempt);
      }
      return createPassingValidationResult(config.podId, config.attempt);
    };

    const ctx = createTestContext({
      runtime,
      validationResultFactory,
      simulatedReworkChangesSource: true,
    });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Update styles' },
      'user-1',
    );
    await manager.processPod(pod.id);

    const final = manager.getSession(pod.id);
    expect(final.lastValidationResult).not.toBeNull();
    expect(final.lastValidationResult?.overall).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// 3. Escalation flow -- agent asks a question, human responds, completes
// ---------------------------------------------------------------------------

describe('E2E: escalation flow', () => {
  it.each(['preservation-failure', 'replacement-lifecycle'] as const)(
    'retains uncollected guidance across %s',
    async (fault) => {
      const ctx = createTestContext();
      const profile = ctx.profileStore.get('test-profile');
      vi.spyOn(ctx.profileStore, 'get').mockReturnValue({
        ...profile,
        warmImageTag: 'fixture.azurecr.io/worker:local',
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Preserve guidance', executionTarget: 'sandbox' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'old-container',
        worktreePath: '/tmp/worktree/abc',
      });
      ctx.nudgeRepo.queue(pod.id, 'Keep the existing behavior');
      vi.mocked(ctx.containerManager.getStatus).mockImplementation(async () => {
        if (fault === 'replacement-lifecycle') {
          ctx.podRepo.incrementLifecycleGeneration(pod.id);
          ctx.podRepo.update(pod.id, { status: 'running', containerId: 'replacement-container' });
        }
        throw new Error('fixture preservation unavailable');
      });
      await manager.handleCompletion(pod.id);
      const current = manager.getSession(pod.id);
      expect(current.status).toBe(fault === 'replacement-lifecycle' ? 'running' : 'failed');
      expect(current.containerId).toBe(
        fault === 'replacement-lifecycle' ? 'replacement-container' : 'old-container',
      );
      if (fault === 'preservation-failure') {
        expect(current.failureReason).toContain('Workspace preservation failed');
        expect(current.finalization?.sourcePreservedAt).toBeNull();
      }
      expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(true);
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
      expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, 'read-without-ack'] as const)(
    'reconciles retained-worker completion with collected reply=%s',
    async (collectReply) => {
      // The original worker remains open at its escalation. A detached/absent
      // MCP waiter uses the durable check_messages queue, not a second worker.
      let resolveSpawnBlock!: () => void;
      const spawnBlock = new Promise<void>((r) => {
        resolveSpawnBlock = r;
      });

      const runtime = createMockRuntime({
        spawn: vi.fn(async function* (config): AsyncIterable<AgentEvent> {
          yield statusEvent('Thinking...');
          yield escalationEvent(config.podId, 'Should I use CSS variables or Tailwind?');
          // Block until sendMessage resolves the escalation
          await spawnBlock;
          if (collectReply !== false) {
            const delivery = ctx.nudgeRepo.readPending(config.podId);
            expect(delivery?.messages).toEqual(['Use CSS variables please']);
            if (!delivery) throw new Error('Missing guidance delivery');
            if (collectReply === true)
              ctx.nudgeRepo.acknowledgeDelivery(config.podId, delivery.deliveryId);
          }
          yield statusEvent('Using CSS variables as instructed');
          yield completeEvent('Dark mode implemented with CSS variables');
        }),
        resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
          yield statusEvent('Using CSS variables as instructed');
          yield completeEvent('Dark mode implemented with CSS variables');
        }),
      });

      const ctx = createTestContext({ runtime });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add dark mode' },
        'user-1',
      );

      // Start processing in the background -- it will hang at the escalation
      const processPromise = manager.processPod(pod.id);

      // Wait a tick for the generator to yield the escalation event
      await vi.waitFor(
        () => {
          const s = manager.getSession(pod.id);
          expect(s.status).toBe('awaiting_input');
        },
        { timeout: 2000 },
      );

      const awaitingSession = manager.getSession(pod.id);
      expect(awaitingSession.status).toBe('awaiting_input');
      expect(awaitingSession.pendingEscalation).not.toBeNull();
      expect(awaitingSession.escalationCount).toBe(1);

      const enqueue = vi.spyOn(ctx.nudgeRepo, 'queue').mockImplementationOnce(() => {
        throw new Error('fixture reply enqueue failed');
      });
      await expect(manager.sendMessage(pod.id, 'Use CSS variables please')).rejects.toThrow(
        'fixture reply enqueue failed',
      );
      expect(manager.getSession(pod.id).pendingEscalation).toEqual(
        awaitingSession.pendingEscalation,
      );
      expect(manager.getSession(pod.id).status).toBe('awaiting_input');
      expect(ctx.nudgeRepo.listPending(pod.id)).toEqual([]);
      expect(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM completion_decisions WHERE pod_id = ?')
          .get(pod.id),
      ).toEqual({ count: 0 });
      enqueue.mockRestore();
      // Persist the reply and queue it for the existing worker.
      await manager.sendMessage(pod.id, 'Use CSS variables please');
      expect(ctx.nudgeRepo.listPending(pod.id).map((entry) => entry.message)).toEqual([
        'Use CSS variables please',
      ]);

      // Unblock the original spawn generator so processPod can finish
      resolveSpawnBlock();
      await processPromise;

      // The original worker consumes the durable answer before validation.
      const final = manager.getSession(pod.id);
      expect(final.status).toBe(collectReply === true ? 'validated' : 'failed');
      expect(runtime.resume).not.toHaveBeenCalled();
      if (collectReply === true) {
        expect(ctx.nudgeRepo.listPending(pod.id)).toEqual([]);
      } else {
        expect(final.failureReason).toContain('uncollected human guidance');
        expect(ctx.nudgeRepo.listPending(pod.id).map((entry) => entry.message)).toEqual([
          'Use CSS variables please',
        ]);
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        expect(final.prUrl).toBeNull();
        await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
          code: 'UNCOLLECTED_HUMAN_GUIDANCE',
        });
        await expect(manager.triggerValidation(pod.id)).rejects.toMatchObject({
          code: 'UNCOLLECTED_HUMAN_GUIDANCE',
        });
        await expect(manager.revalidateSession(pod.id, { force: true })).rejects.toMatchObject({
          code: 'UNCOLLECTED_HUMAN_GUIDANCE',
        });
        expect(final.finalization?.sourcePreservedAt).toBeTruthy();
        expect(final.containerId).toBeTruthy();
        await manager.handleCompletion(pod.id);
        expect(manager.getSession(pod.id).status).toBe('failed');
        vi.mocked(runtime.spawn).mockImplementationOnce(async function* (config) {
          expect(config.task).toContain('Uncollected human guidance');
          expect(config.task).toContain('Use CSS variables please');
          const delivery = ctx.nudgeRepo.readPending(config.podId);
          expect(delivery?.messages).toEqual(['Use CSS variables please']);
          if (!delivery) throw new Error('Missing guidance delivery');
          ctx.nudgeRepo.acknowledgeDelivery(config.podId, delivery.deliveryId);
          yield completeEvent('Applied saved guidance to preserved work');
        });
        const recoveredManager = createPodManager(ctx.deps);
        await recoveredManager.triggerValidation(pod.id, { force: true });
        expect(manager.getSession(pod.id).status).toBe('queued');
        expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(true);
        await recoveredManager.processPod(pod.id);
        expect(manager.getSession(pod.id).status).toBe('validated');
        expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(false);
        expect(runtime.spawn).toHaveBeenCalledTimes(2);
      }
      expect(
        ctx.db.prepare('SELECT response FROM completion_decisions WHERE pod_id = ?').all(pod.id),
      ).toEqual([{ response: 'Use CSS variables please' }]);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Max retries exhausted -- validation fails 3 times, pod needs review
// ---------------------------------------------------------------------------

describe('E2E: max retries exhausted', () => {
  it('transitions to review_required after maxValidationAttempts exhausted', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Initial attempt');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Retry attempt');
      }),
    });

    // Every validation call fails
    const validationResultFactory = (config: {
      podId: string;
      attempt: number;
    }): ValidationResult => {
      return createFailingValidationResult(config.podId, config.attempt);
    };

    const ctx = createTestContext({
      runtime,
      validationResultFactory,
      maxValidationAttempts: 3,
      simulatedReworkChangesSource: true,
    });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build a dashboard' },
      'user-1',
    );

    await manager.processPod(pod.id);

    const final = manager.getSession(pod.id);
    expect(final.status).toBe('review_required');
    expect(final.validationAttempts).toBe(3);

    // Agent was resumed twice (after attempt 1 and attempt 2), not after
    // the final attempt (#3) since that one transitions directly to review_required.
    expect(runtime.resume).toHaveBeenCalledTimes(2);

    // Validation was called 3 times total
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(3);
  });

  it('does not resume the agent on the final exhausted attempt', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Done');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Retry');
      }),
    });

    const alwaysFail = (config: { podId: string; attempt: number }): ValidationResult =>
      createFailingValidationResult(config.podId, config.attempt);

    const ctx = createTestContext({
      runtime,
      validationResultFactory: alwaysFail,
      maxValidationAttempts: 1, // only 1 attempt allowed
    });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Impossible task' },
      'user-1',
    );

    await manager.processPod(pod.id);

    const final = manager.getSession(pod.id);
    expect(final.status).toBe('review_required');
    expect(final.validationAttempts).toBe(1);

    // No resume at all -- the single attempt exhausted and there are no retries
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });

  it('extends attempts on review_required pod and retries', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Initial attempt');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Retry after extend');
      }),
    });

    let callCount = 0;
    const validationResultFactory = (config: {
      podId: string;
      attempt: number;
    }): ValidationResult => {
      callCount++;
      // First call fails, second passes
      if (callCount <= 1) {
        return createFailingValidationResult(config.podId, config.attempt);
      }
      return createPassingValidationResult(config.podId, config.attempt);
    };

    const ctx = createTestContext({
      runtime,
      validationResultFactory,
      maxValidationAttempts: 1, // exhaust after 1
    });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession({ profileName: 'test-profile', task: 'Extend me' }, 'user-1');

    await manager.processPod(pod.id);

    // Should be in review_required after 1 failed attempt
    const mid = manager.getSession(pod.id);
    expect(mid.status).toBe('review_required');
    expect(mid.maxValidationAttempts).toBe(1);

    // Extend attempts and retry
    await manager.extendAttempts(pod.id, 2);

    expect(manager.getSession(pod.id).maxValidationAttempts).toBe(3);
    // Acceptance is immediate; recovery continues asynchronously.
    await vi.waitFor(() => {
      expect(manager.getSession(pod.id).status).not.toBe('review_required');
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Kill mid-run -- pod gets killed while running
// ---------------------------------------------------------------------------

describe('E2E: kill mid-run', () => {
  it('kills a running pod, transitions through killing to killed', async () => {
    // We make the spawn generator hang so the pod stays in "running"
    let resolveHang!: () => void;
    const hang = new Promise<void>((r) => {
      resolveHang = r;
    });

    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Starting work...');
        // Hang forever until we unblock
        await hang;
        yield completeEvent('Never reached');
      }),
    });

    const ctx = createTestContext({ runtime });
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Long running task' },
      'user-1',
    );

    // Start processing in background (it will hang)
    const processPromise = manager.processPod(pod.id);

    // Wait for the pod to reach running state
    await vi.waitFor(
      () => {
        const s = manager.getSession(pod.id);
        expect(s.status).toBe('running');
      },
      { timeout: 2000 },
    );

    // Kill the pod while it is running
    await manager.killSession(pod.id);

    const killed = manager.getSession(pod.id);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).not.toBeNull();

    // Container kill and worktree cleanup were called
    expect(ctx.containerManager.kill).toHaveBeenCalledWith('container-123');
    expect(ctx.worktreeManager.cleanup).toHaveBeenCalledWith('/tmp/worktree/abc');
    expect(runtime.abort).toHaveBeenCalledWith(pod.id);

    // Unblock processPod so it can finish (it will hit the catch block
    // since the pod is already in a terminal state)
    resolveHang();
    await processPromise;

    // Pod should still be killed (processPod's catch should not
    // overwrite the terminal state)
    expect(manager.getSession(pod.id).status).toBe('killed');
  });

  it('kills a queued pod directly (no container to clean up)', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Abandoned task' },
      'user-1',
    );
    expect(pod.status).toBe('queued');

    await manager.killSession(pod.id);

    const killed = manager.getSession(pod.id);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).not.toBeNull();

    // No container or worktree to clean up
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
  });

  it('emits pod.completed with killed status', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'To be killed' },
      'user-1',
    );

    const events: { type: string; finalStatus?: string }[] = [];
    ctx.eventBus.subscribe((e) => events.push(e as { type: string; finalStatus?: string }));

    await manager.killSession(pod.id);

    const completedEvent = events.find((e) => e.type === 'pod.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.finalStatus).toBe('killed');
  });
});

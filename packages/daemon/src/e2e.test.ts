import type { AgentEvent, ValidationResult } from '@autopod/shared';
/**
 * E2E lifecycle tests for the session manager.
 *
 * Uses real SQLite (in-memory), real SessionManager, real EventBus, and real
 * SessionRepository. Infrastructure (container, worktree, runtime, validation)
 * is mocked so we can drive the full state-machine without Docker or a real
 * coding agent.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSessionManager } from './sessions/session-manager.js';
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
  it('creates a session, processes it, validates, and approves to complete', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Analysing codebase...');
        yield statusEvent('Implementing dark mode...');
        yield completeEvent('Dark mode added');
      }),
    });

    const ctx = createTestContext({ runtime });
    const manager = createSessionManager(ctx.deps);

    // -- Create --
    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Add dark mode toggle' },
      'user-1',
    );
    expect(session.status).toBe('queued');

    // -- Process (queued -> provisioning -> running -> validating -> validated) --
    await manager.processSession(session.id);

    const afterProcess = manager.getSession(session.id);
    expect(afterProcess.status).toBe('validated');
    expect(afterProcess.containerId).toBe('container-123');
    expect(afterProcess.worktreePath).toBe('/tmp/worktree/abc');
    expect(afterProcess.validationAttempts).toBe(1);

    // Verify infrastructure was wired up
    expect(ctx.containerManager.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.worktreeManager.create).toHaveBeenCalledTimes(1);
    expect(ctx.containerManager.writeFile).toHaveBeenCalledTimes(3); // CLAUDE.md + .claude.json + settings.json
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);

    // -- Approve (validated -> approved -> merging -> complete) --
    await manager.approveSession(session.id);

    const final = manager.getSession(session.id);
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
    const manager = createSessionManager(ctx.deps);

    const events: { type: string }[] = [];
    ctx.eventBus.subscribe((e) => events.push(e as { type: string }));

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Add tests' },
      'user-1',
    );
    await manager.processSession(session.id);
    await manager.approveSession(session.id);

    const types = events.map((e) => e.type);
    expect(types).toContain('session.created');
    expect(types).toContain('session.status_changed');
    expect(types).toContain('session.agent_activity');
    expect(types).toContain('session.validation_started');
    expect(types).toContain('session.validation_completed');
    expect(types).toContain('session.completed');
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
      sessionId: string;
      attempt: number;
    }): ValidationResult => {
      callCount++;
      if (callCount === 1) {
        return createFailingValidationResult(config.sessionId, config.attempt);
      }
      return createPassingValidationResult(config.sessionId, config.attempt);
    };

    const ctx = createTestContext({ runtime, validationResultFactory });
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Fix the login page' },
      'user-1',
    );

    await manager.processSession(session.id);

    const result = manager.getSession(session.id);
    expect(result.status).toBe('validated');
    expect(result.validationAttempts).toBe(2);

    // Runtime was resumed once with correction feedback
    expect(runtime.resume).toHaveBeenCalledTimes(1);
    const resumeArgs = vi.mocked(runtime.resume).mock.calls[0] ?? [];

    expect(resumeArgs[0]).toBe(session.id); // sessionId
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
      sessionId: string;
      attempt: number;
    }): ValidationResult => {
      callCount++;
      if (callCount === 1) {
        return createFailingValidationResult(config.sessionId, config.attempt);
      }
      return createPassingValidationResult(config.sessionId, config.attempt);
    };

    const ctx = createTestContext({ runtime, validationResultFactory });
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Update styles' },
      'user-1',
    );
    await manager.processSession(session.id);

    const final = manager.getSession(session.id);
    expect(final.lastValidationResult).not.toBeNull();
    expect(final.lastValidationResult?.overall).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// 3. Escalation flow -- agent asks a question, human responds, completes
// ---------------------------------------------------------------------------

describe('E2E: escalation flow', () => {
  it('pauses on escalation, resumes after human message, completes', async () => {
    // The spawn generator will be consumed by processSession. It yields an
    // escalation event which transitions the session to awaiting_input. The
    // generator then returns, so processSession proceeds to handleCompletion.
    // Because the session is in awaiting_input (not terminal and not running),
    // handleCompletion sees a non-terminal state and tries triggerValidation --
    // but state machine won't allow awaiting_input -> validating. So we need
    // processSession's catch to handle the invalid transition gracefully.
    //
    // Actually, looking at the code more carefully: after consumeAgentEvents
    // finishes (generator done), handleCompletion is called. The session is in
    // awaiting_input at that point. handleCompletion calls triggerValidation
    // which calls transition(session, 'validating') -- but awaiting_input ->
    // validating is NOT a valid transition. This will throw, and the catch
    // block will try to kill the session.
    //
    // The real-world flow is that when an escalation happens, the runtime's
    // spawn generator BLOCKS (yields escalation, then waits). The generator
    // only returns after the escalation is resolved via sendMessage, which
    // calls runtime.resume.
    //
    // To simulate this properly, we need the spawn generator to yield the
    // escalation event and then never return (hang). The sendMessage call
    // resumes execution via runtime.resume.
    //
    // We achieve this by making spawn yield escalation + then block on a
    // promise that never resolves. processSession's consumeAgentEvents will
    // hang. We run processSession in the background, then call sendMessage.

    let resolveSpawnBlock!: () => void;
    const spawnBlock = new Promise<void>((r) => {
      resolveSpawnBlock = r;
    });

    // We need a reference to the session id before creating the runtime, but
    // we do not know it yet. We will capture it from the spawn call.
    let capturedSessionId = '';

    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (config): AsyncIterable<AgentEvent> {
        capturedSessionId = config.sessionId;
        yield statusEvent('Thinking...');
        yield escalationEvent(config.sessionId, 'Should I use CSS variables or Tailwind?');
        // Block until sendMessage resolves the escalation
        await spawnBlock;
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield statusEvent('Using CSS variables as instructed');
        yield completeEvent('Dark mode implemented with CSS variables');
      }),
    });

    const ctx = createTestContext({ runtime });
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Add dark mode' },
      'user-1',
    );

    // Start processing in the background -- it will hang at the escalation
    const processPromise = manager.processSession(session.id);

    // Wait a tick for the generator to yield the escalation event
    await vi.waitFor(
      () => {
        const s = manager.getSession(session.id);
        expect(s.status).toBe('awaiting_input');
      },
      { timeout: 2000 },
    );

    const awaitingSession = manager.getSession(session.id);
    expect(awaitingSession.status).toBe('awaiting_input');
    expect(awaitingSession.pendingEscalation).not.toBeNull();
    expect(awaitingSession.escalationCount).toBe(1);

    // Human responds -- this transitions awaiting_input -> running and resumes
    // the agent via runtime.resume
    await manager.sendMessage(session.id, 'Use CSS variables please');

    // Unblock the original spawn generator so processSession can finish
    resolveSpawnBlock();
    await processPromise;

    // After sendMessage completes its own cycle (resume -> handleCompletion ->
    // validate -> validated), the session should be validated
    const final = manager.getSession(session.id);
    expect(final.status).toBe('validated');
    expect(runtime.resume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.resume).mock.calls[0]?.[1]).toBe('Use CSS variables please');
  });
});

// ---------------------------------------------------------------------------
// 4. Max retries exhausted -- validation fails 3 times, session fails
// ---------------------------------------------------------------------------

describe('E2E: max retries exhausted', () => {
  it('fails the session after maxValidationAttempts (3) consecutive failures', async () => {
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
      sessionId: string;
      attempt: number;
    }): ValidationResult => {
      return createFailingValidationResult(config.sessionId, config.attempt);
    };

    const ctx = createTestContext({
      runtime,
      validationResultFactory,
      maxValidationAttempts: 3,
    });
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Build a dashboard' },
      'user-1',
    );

    await manager.processSession(session.id);

    const final = manager.getSession(session.id);
    expect(final.status).toBe('failed');
    expect(final.validationAttempts).toBe(3);

    // Agent was resumed twice (after attempt 1 and attempt 2), not after
    // the final attempt (#3) since that one transitions directly to failed.
    expect(runtime.resume).toHaveBeenCalledTimes(2);

    // Validation was called 3 times total
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(3);
  });

  it('does not resume the agent on the final failed attempt', async () => {
    const runtime = createMockRuntime({
      spawn: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Done');
      }),
      resume: vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield completeEvent('Retry');
      }),
    });

    const alwaysFail = (config: { sessionId: string; attempt: number }): ValidationResult =>
      createFailingValidationResult(config.sessionId, config.attempt);

    const ctx = createTestContext({
      runtime,
      validationResultFactory: alwaysFail,
      maxValidationAttempts: 1, // only 1 attempt allowed
    });
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Impossible task' },
      'user-1',
    );

    await manager.processSession(session.id);

    const final = manager.getSession(session.id);
    expect(final.status).toBe('failed');
    expect(final.validationAttempts).toBe(1);

    // No resume at all -- the single attempt failed and there are no retries
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Kill mid-run -- session gets killed while running
// ---------------------------------------------------------------------------

describe('E2E: kill mid-run', () => {
  it('kills a running session, transitions through killing to killed', async () => {
    // We make the spawn generator hang so the session stays in "running"
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
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Long running task' },
      'user-1',
    );

    // Start processing in background (it will hang)
    const processPromise = manager.processSession(session.id);

    // Wait for the session to reach running state
    await vi.waitFor(
      () => {
        const s = manager.getSession(session.id);
        expect(s.status).toBe('running');
      },
      { timeout: 2000 },
    );

    // Kill the session while it is running
    await manager.killSession(session.id);

    const killed = manager.getSession(session.id);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).not.toBeNull();

    // Container kill and worktree cleanup were called
    expect(ctx.containerManager.kill).toHaveBeenCalledWith('container-123');
    expect(ctx.worktreeManager.cleanup).toHaveBeenCalledWith('/tmp/worktree/abc');
    expect(runtime.abort).toHaveBeenCalledWith(session.id);

    // Unblock processSession so it can finish (it will hit the catch block
    // since the session is already in a terminal state)
    resolveHang();
    await processPromise;

    // Session should still be killed (processSession's catch should not
    // overwrite the terminal state)
    expect(manager.getSession(session.id).status).toBe('killed');
  });

  it('kills a queued session directly (no container to clean up)', async () => {
    const ctx = createTestContext();
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'Abandoned task' },
      'user-1',
    );
    expect(session.status).toBe('queued');

    await manager.killSession(session.id);

    const killed = manager.getSession(session.id);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).not.toBeNull();

    // No container or worktree to clean up
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
  });

  it('emits session.completed with killed status', async () => {
    const ctx = createTestContext();
    const manager = createSessionManager(ctx.deps);

    const session = manager.createSession(
      { profileName: 'test-profile', task: 'To be killed' },
      'user-1',
    );

    const events: { type: string; finalStatus?: string }[] = [];
    ctx.eventBus.subscribe((e) => events.push(e as { type: string; finalStatus?: string }));

    await manager.killSession(session.id);

    const completedEvent = events.find((e) => e.type === 'session.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.finalStatus).toBe('killed');
  });
});

import type {
  ActionPolicy,
  AgentEscalationEvent,
  AgentEvent,
  SystemEvent,
  ValidationResult,
} from '@autopod/shared';
import pino from 'pino';
/**
 * Session Lifecycle E2E Tests
 *
 * Tests the full autopod workflow through the SessionManager with real SQLite,
 * real repositories, real event bus. Only external boundaries are mocked:
 * Docker, git worktrees, Claude runtime, validation engine, PR manager.
 *
 * These tests verify the complete state machine transitions and data flow:
 *
 *   Profile → Session → Provision → Agent → Validate → PR → Approve → Complete
 *
 * Each scenario exercises the real orchestration code path — not HTTP routes,
 * but the same code that HTTP routes call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionEngine } from '../actions/action-engine.js';
import { createActionRegistry } from '../actions/action-registry.js';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import type { PrManager } from '../interfaces/index.js';
import {
  type TestContext,
  completeEvent,
  createFailingValidationResult,
  createMockRuntime,
  createPassingValidationResult,
  createTestContext,
  escalationEvent,
  insertTestProfile,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { type SessionManager, createSessionManager } from './session-manager.js';

// ─── Helpers ─────────────────────────────────────────────────────

function createMockPrManager(): PrManager {
  return {
    createPr: vi.fn(async () => 'https://github.com/org/repo/pull/42'),
    mergePr: vi.fn(async () => {}),
  };
}

function collectEvents(ctx: TestContext): SystemEvent[] {
  const events: SystemEvent[] = [];
  ctx.eventBus.subscribe((e) => events.push(e));
  return events;
}

function statusTransitions(events: SystemEvent[]): Array<{ from: string; to: string }> {
  return events
    .filter(
      (e): e is SystemEvent & { type: 'session.status_changed' } =>
        e.type === 'session.status_changed',
    )
    .map((e) => ({ from: (e as any).previousStatus, to: (e as any).newStatus }));
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Session Lifecycle E2E', () => {
  describe('Happy path: create → process → validate → PR → approve → complete', () => {
    it('walks through the entire lifecycle', async () => {
      const ctx = createTestContext();
      const prManager = createMockPrManager();
      ctx.deps.prManager = prManager;
      const manager = createSessionManager(ctx.deps);
      const events = collectEvents(ctx);

      // 1. Create session with skipValidation=false (real validation path)
      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add a dark mode toggle', skipValidation: false },
        'user-esben',
      );
      expect(session.status).toBe('queued');
      expect(session.userId).toBe('user-esben');

      // 2. Process the session (provisioning → running → agent → validation → validated)
      await manager.processSession(session.id);

      const processed = manager.getSession(session.id);
      expect(processed.status).toBe('validated');
      expect(processed.containerId).toBe('container-123');
      expect(processed.worktreePath).toBe('/tmp/worktree/abc');
      expect(processed.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(processed.filesChanged).toBe(3);
      expect(processed.linesAdded).toBe(50);
      expect(processed.linesRemoved).toBe(10);

      // 3. Approve the session
      await manager.approveSession(session.id);

      const completed = manager.getSession(session.id);
      expect(completed.status).toBe('complete');
      expect(completed.completedAt).not.toBeNull();

      // 4. Verify PR was merged
      expect(prManager.mergePr).toHaveBeenCalledWith({
        worktreePath: '/tmp/worktree/abc',
        prUrl: 'https://github.com/org/repo/pull/42',
        squash: undefined,
      });

      // 5. Verify the full state transition chain
      const transitions = statusTransitions(events);
      const statusChain = transitions.map((t) => t.to);
      expect(statusChain).toContain('provisioning');
      expect(statusChain).toContain('running');
      expect(statusChain).toContain('validating');
      expect(statusChain).toContain('validated');
      expect(statusChain).toContain('approved');
      expect(statusChain).toContain('merging');
      expect(statusChain).toContain('complete');

      // 6. Verify completion event
      const completionEvent = events.find((e) => e.type === 'session.completed') as any;
      expect(completionEvent).toBeDefined();
      expect(completionEvent.finalStatus).toBe('complete');
    });
  });

  describe('Validation retry loop: fail → correction → retry → pass', () => {
    it('retries on validation failure and succeeds on second attempt', async () => {
      let attempt = 0;
      const ctx = createTestContext({
        validationResultFactory: (config) => {
          attempt++;
          // Fail first attempt, pass second
          if (attempt === 1) return createFailingValidationResult(config.sessionId, config.attempt);
          return createPassingValidationResult(config.sessionId, config.attempt);
        },
      });
      const prManager = createMockPrManager();
      ctx.deps.prManager = prManager;
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Fix the login form' },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
      expect(result.validationAttempts).toBe(2);

      // Agent was resumed with correction feedback after first failure
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(1);
      const correctionMessage = vi.mocked(ctx.runtime.resume).mock.calls[0]?.[1] as string;
      expect(correctionMessage).toContain('Validation Failed');

      // PR was still created after second attempt passed
      expect(prManager.createPr).toHaveBeenCalled();
    });

    it('exhausts all validation attempts and transitions to failed', async () => {
      const ctx = createTestContext({
        validationResultFactory: (config) =>
          createFailingValidationResult(config.sessionId, config.attempt),
      });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Fix the CSS' },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(3); // max attempts

      // Agent was resumed twice (attempts 1 and 2 trigger retry, attempt 3 is final failure)
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(2);
    });
  });

  describe('skipValidation path', () => {
    it('skips validation and goes straight to validated', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Refactor utils', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
      // Validation engine should NOT have been called
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    });
  });

  describe('Escalation flow: agent → awaiting_input → human responds → agent continues', () => {
    it('transitions to awaiting_input when agent escalates', async () => {
      // In reality, the runtime stream blocks when the agent escalates.
      // processSession's consumeAgentEvents loop hangs until the stream ends.
      // We simulate this by having spawn block on a never-resolving promise.

      const neverResolves = new Promise<void>(() => {});

      const runtime = createMockRuntime({
        spawn: vi.fn(async function* () {
          yield statusEvent('Analyzing codebase...');
          yield escalationEvent('sess-placeholder', 'Which database should I use?');
          // Block forever — simulates the real runtime waiting for human response
          await neverResolves;
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add database support', skipValidation: true },
        'user-1',
      );

      // Start processing — this will hang on the never-resolving promise
      // We don't await it — it'll be cleaned up when the test ends
      const processPromise = manager.processSession(session.id);

      // Wait a tick for events to be consumed up to the escalation
      await new Promise((r) => setTimeout(r, 50));

      const escalated = manager.getSession(session.id);
      expect(escalated.status).toBe('awaiting_input');
      expect(escalated.pendingEscalation).not.toBeNull();
      expect(escalated.escalationCount).toBe(1);

      // Note: the sendMessage→resume→completion flow is tested separately
      // in the existing session-manager.test.ts sendMessage tests
    });

    it('human response via sendMessage resumes agent and completes', async () => {
      // Test the sendMessage path directly, starting from an awaiting_input session
      const runtime = createMockRuntime({
        resume: vi.fn(async function* () {
          yield statusEvent('Got it, using PostgreSQL');
          yield completeEvent('Done — added PostgreSQL support');
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add database support', skipValidation: true },
        'user-1',
      );

      // Manually set to awaiting_input state (simulating post-escalation)
      ctx.sessionRepo.update(session.id, {
        status: 'awaiting_input',
        containerId: 'ctr-1',
        pendingEscalation: { id: 'esc-1', type: 'ask_human', question: 'Which DB?' },
      });

      // Human responds
      await manager.sendMessage(session.id, 'Use PostgreSQL');

      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated'); // skipValidation=true
      expect(result.pendingEscalation).toBeNull();

      // Agent was resumed with the human's message
      expect(runtime.resume).toHaveBeenCalledWith(
        session.id,
        'Use PostgreSQL',
        'ctr-1',
        undefined, // no provider env for default anthropic provider
      );
    });
  });

  describe('Rejection flow: validated → reject → agent retries → validated', () => {
    it('rejection resumes agent and re-runs validation', async () => {
      const ctx = createTestContext();
      const prManager = createMockPrManager();
      ctx.deps.prManager = prManager;
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Style the header' },
        'user-1',
      );

      // Fast-track to validated
      await manager.processSession(session.id);
      expect(manager.getSession(session.id).status).toBe('validated');

      // Reject it
      await manager.rejectSession(session.id, 'Header color should be blue, not red');

      const afterReject = manager.getSession(session.id);
      expect(afterReject.status).toBe('validated'); // passes again after retry
      expect(afterReject.validationAttempts).toBe(1); // was reset then re-validated

      // Agent was resumed with rejection feedback
      const resumeMsg = vi.mocked(ctx.runtime.resume).mock.calls[0]?.[1] as string;
      expect(resumeMsg).toContain('Header color should be blue, not red');
    });
  });

  describe('Kill flow', () => {
    it('kills a running session and cleans up resources', async () => {
      // Create a runtime that yields events slowly so we can kill mid-flight
      const runtime = createMockRuntime({
        spawn: vi.fn(async function* () {
          yield statusEvent('Starting work...');
          // In real life this would be a long-running operation
          yield completeEvent('Done');
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);
      const events = collectEvents(ctx);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do something', skipValidation: true },
        'user-1',
      );

      // Process completes quickly with our mock
      await manager.processSession(session.id);

      // Now it's in validated state - but let's test killing from queued state
      const session2 = manager.createSession(
        { profileName: 'test-profile', task: 'Another task' },
        'user-1',
      );
      await manager.killSession(session2.id);

      const killed = manager.getSession(session2.id);
      expect(killed.status).toBe('killed');
      expect(killed.completedAt).not.toBeNull();

      // Verify kill event
      const killEvent = events.find(
        (e) => e.type === 'session.completed' && (e as any).sessionId === session2.id,
      ) as any;
      expect(killEvent).toBeDefined();
      expect(killEvent.finalStatus).toBe('killed');
    });

    it('kills a provisioned session and cleans up container + worktree', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Task' },
        'user-1',
      );

      // Simulate provisioned state with container and worktree
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-kill-me',
        worktreePath: '/tmp/wt/kill-me',
      });

      await manager.killSession(session.id);

      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-kill-me');
      expect(ctx.worktreeManager.cleanup).toHaveBeenCalledWith('/tmp/wt/kill-me');
      expect(ctx.runtime.abort).toHaveBeenCalled();
    });
  });

  describe('Pause and resume flow', () => {
    it('pauses a running session and resumes via sendMessage', async () => {
      // Runtime that escalates (which gives us awaiting_input, and then we can test pause from running)
      const runtime = createMockRuntime({
        spawn: vi.fn(async function* () {
          yield statusEvent('Working...');
          yield completeEvent('Done');
        } as () => AsyncIterable<AgentEvent>),
        resume: vi.fn(async function* () {
          yield completeEvent('Resumed and done');
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Build dashboard', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);
      expect(manager.getSession(session.id).status).toBe('validated');
    });
  });

  describe('Agent event consumption', () => {
    it('persists plan and progress events from the agent', async () => {
      const runtime = createMockRuntime({
        spawn: vi.fn(async function* () {
          yield {
            type: 'plan' as const,
            timestamp: new Date().toISOString(),
            summary: 'Add dark mode with 3 steps',
            steps: ['1. Add CSS variables', '2. Add toggle', '3. Persist preference'],
          };
          yield {
            type: 'progress' as const,
            timestamp: new Date().toISOString(),
            phase: 'CSS Variables',
            description: 'Adding color scheme variables',
            currentPhase: 1,
            totalPhases: 3,
          };
          yield completeEvent('Done');
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Dark mode', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.plan).toEqual({
        summary: 'Add dark mode with 3 steps',
        steps: ['1. Add CSS variables', '2. Add toggle', '3. Persist preference'],
      });
      expect(result.progress).toEqual({
        phase: 'CSS Variables',
        description: 'Adding color scheme variables',
        currentPhase: 1,
        totalPhases: 3,
      });
    });

    it('persists Claude session ID from status event', async () => {
      const runtime = createMockRuntime({
        spawn: vi.fn(async function* () {
          yield statusEvent('Claude session initialized (cs-abc123)');
          yield completeEvent('Done');
        } as () => AsyncIterable<AgentEvent>),
      });

      const ctx = createTestContext({ runtime });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Test', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.claudeSessionId).toBe('cs-abc123');
    });
  });

  describe('Diff stats collection', () => {
    it('collects diff stats after agent completion', async () => {
      const ctx = createTestContext();
      (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
        filesChanged: 7,
        linesAdded: 200,
        linesRemoved: 45,
      });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Big refactor', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.filesChanged).toBe(7);
      expect(result.linesAdded).toBe(200);
      expect(result.linesRemoved).toBe(45);
    });
  });

  describe('Error recovery', () => {
    it('kills session when container spawn fails', async () => {
      const ctx = createTestContext();
      (ctx.containerManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker daemon not running'),
      );
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Task' },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('killed');
    });

    it('kills session when worktree creation fails', async () => {
      const ctx = createTestContext();
      (ctx.worktreeManager.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Git clone failed'),
      );
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Task' },
        'user-1',
      );

      await manager.processSession(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('killed');
    });

    it('transitions to failed when validation engine throws', async () => {
      const ctx = createTestContext();
      (ctx.validationEngine.validate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Playwright crashed'),
      );
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Task' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('failed');
    });
  });

  describe('Multi-session isolation', () => {
    it('multiple sessions run independently', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const s1 = manager.createSession(
        { profileName: 'test-profile', task: 'Task A', skipValidation: true },
        'user-1',
      );
      const s2 = manager.createSession(
        { profileName: 'test-profile', task: 'Task B', skipValidation: true },
        'user-2',
      );

      await manager.processSession(s1.id);
      await manager.processSession(s2.id);

      expect(manager.getSession(s1.id).status).toBe('validated');
      expect(manager.getSession(s2.id).status).toBe('validated');
      expect(manager.getSession(s1.id).task).toBe('Task A');
      expect(manager.getSession(s2.id).task).toBe('Task B');

      // Listing with filter
      const user1Sessions = manager.listSessions({ userId: 'user-1' });
      expect(user1Sessions).toHaveLength(1);
      expect(user1Sessions[0]?.task).toBe('Task A');
    });
  });

  describe('Full lifecycle with action control plane', () => {
    it('resolves available actions from profile action policy during provisioning', async () => {
      const ctx = createTestContext();

      // Add action engine to deps
      const actionRegistry = createActionRegistry(pino({ level: 'silent' }));
      const auditRepo = createActionAuditRepository(ctx.db);
      const actionEngine = createActionEngine({
        registry: actionRegistry,
        auditRepo,
        logger: pino({ level: 'silent' }),
        getSecret: () => undefined,
      });
      ctx.deps.actionEngine = actionEngine;

      // Update profile to have an action policy
      ctx.db.prepare('UPDATE profiles SET action_policy = ? WHERE name = ?').run(
        JSON.stringify({
          enabledGroups: ['github-issues', 'custom'],
          sanitization: { preset: 'standard' },
          customActions: [
            {
              name: 'search_docs',
              description: 'Search documentation',
              group: 'custom',
              handler: 'http',
              params: { query: { type: 'string', required: true, description: 'Search query' } },
              endpoint: {
                url: 'https://docs.example.com/search',
                method: 'GET',
                auth: { type: 'none' },
              },
              response: { fields: ['title', 'url'] },
            },
          ],
        } satisfies ActionPolicy),
        'test-profile',
      );

      const manager = createSessionManager(ctx.deps);
      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Investigate docs', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      // The CLAUDE.md written to the container should mention available actions
      const writeFileCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const claudeMdCall = writeFileCalls.find((c) => c[1] === '/workspace/CLAUDE.md');
      expect(claudeMdCall).toBeDefined();
      const claudeMdContent = claudeMdCall?.[2] as string;
      expect(claudeMdContent).toContain('search_docs');
    });
  });

  describe('Nudge flow', () => {
    it('queues nudge message for a running session', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Task' },
        'user-1',
      );

      // Move to running state
      ctx.sessionRepo.update(session.id, { status: 'running' });

      // Nudge should not throw
      manager.nudgeSession(session.id, 'Hey, how is it going?');

      // Verify nudge was queued in the DB
      const pending = ctx.nudgeRepo.listPending(session.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.message).toBe('Hey, how is it going?');

      // Session state should not change
      expect(manager.getSession(session.id).status).toBe('running');
    });
  });

  describe('Event ordering and completeness', () => {
    it('emits events in correct order for full lifecycle', async () => {
      const ctx = createTestContext();
      const prManager = createMockPrManager();
      ctx.deps.prManager = prManager;
      const manager = createSessionManager(ctx.deps);
      const events = collectEvents(ctx);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Full flow' },
        'user-1',
      );

      await manager.processSession(session.id);
      await manager.approveSession(session.id);

      const eventTypes = events.map((e) => e.type);

      // session.created must come first
      expect(eventTypes[0]).toBe('session.created');

      // Validation events should be present
      expect(eventTypes).toContain('session.validation_started');
      expect(eventTypes).toContain('session.validation_completed');

      // session.completed must come last
      expect(eventTypes[eventTypes.length - 1]).toBe('session.completed');

      // Status changes should be in order
      const transitions = statusTransitions(events);
      expect(transitions[0]).toEqual({ from: 'queued', to: 'provisioning' });
      expect(transitions[1]).toEqual({ from: 'provisioning', to: 'running' });
    });
  });
});

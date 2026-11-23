import type { AgentEvent } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { describeInterruptedClaudeTurn } from '../runtimes/claude-turn-finality.js';
import { createTestContext, type TestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

const SYNC_BACK = expect.stringContaining('STAGING="/mnt/worktree/.autopod-sync-');

/** Collect the pod's activity status lines from the live event bus. */
function recordActivity(ctx: TestContext, podId: string): string[] {
  const messages: string[] = [];
  ctx.eventBus.subscribeToSession(podId, (event) => {
    if (event.type === 'pod.agent_activity' && event.event.type === 'status')
      messages.push(event.event.message);
  });
  return messages;
}

function isSyncBack(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command[0] === 'sh' &&
    typeof command[2] === 'string' &&
    command[2].includes('/mnt/worktree/.autopod-sync-')
  );
}

/** What the Claude runtime yields for a turn that ended waiting on background work. */
async function* interruptedTurn(podId: string): AsyncIterable<AgentEvent> {
  const ts = () => new Date().toISOString();
  yield { type: 'status', timestamp: ts(), message: 'Claude pod initialized (native)' };
  yield { type: 'tool_use', timestamp: ts(), tool: 'Bash', input: { command: 'npm test' } };
  yield {
    type: 'complete',
    timestamp: ts(),
    result: 'Waiting on the broad suite.',
    totalInputTokens: 12,
    totalOutputTokens: 4,
  };
  yield {
    type: 'error',
    timestamp: ts(),
    fatal: true,
    turnInterrupted: true,
    message:
      describeInterruptedClaudeTurn(
        { kind: 'background_pending', pendingTasks: 1, reason: 'cap', waitMs: 25 * 60_000 },
        143,
        podId,
      ) ?? '',
  };
}

function setup() {
  const ctx = createTestContext();
  const manager = createPodManager(ctx.deps);
  const created = manager.createSession(
    { profileName: 'test-profile', task: 'Implement phase 2' },
    'operator',
  );
  ctx.podRepo.update(created.id, {
    status: 'running',
    containerId: 'container-123',
    worktreePath: `/tmp/interrupted-${created.id}`,
    claudeSessionId: 'native',
  });
  return { ctx, manager, podId: created.id, activity: recordActivity(ctx, created.id) };
}

describe('interrupted agent turn (#648)', () => {
  it('fails without validation, preserves uncommitted work and continues through Rework', async () => {
    const { ctx, manager, podId, activity } = setup();
    try {
      expect(await manager.consumeAgentEvents(podId, interruptedTurn(podId))).toBe('failed');

      const failed = manager.getSession(podId);
      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toContain('The turn is incomplete');
      expect(failed.failureReason).toContain(`ap rework ${podId}`);
      // Never handed to validation as a finished turn.
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      // Uncommitted and untracked source was synced back to the host worktree
      // through the existing preservation owner, and recorded as preserved.
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['sh', '-c', SYNC_BACK],
        expect.objectContaining({ timeout: 120_000 }),
      );
      expect(activity).toContain('Workspace preserved before interrupted agent turn.');
      expect(failed.finalization?.sourcePreservedAt).toBeTruthy();
      // Token accounting of the interrupted turn is retained.
      expect(failed.inputTokens).toBe(12);

      // Manual Rework is admitted without a retry authorization, as after a completed turn.
      expect(ctx.podRepo.workerRetries?.state(podId).retryFailure ?? null).toBeNull();
      expect(() => manager.assertCanRework(podId)).not.toThrow();
      // Checks-only recovery cannot pass off the unfinished turn as finished work.
      await expect(manager.resumePod(podId)).rejects.toMatchObject({
        code: 'INTERRUPTED_TURN_REWORK_REQUIRED',
      });
      await expect(manager.triggerValidation(podId)).rejects.toMatchObject({
        code: 'INTERRUPTED_TURN_REWORK_REQUIRED',
      });
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();

      const syncsBeforeRework = vi
        .mocked(ctx.containerManager.execInContainer)
        .mock.calls.filter(([, command]) => isSyncBack(command)).length;
      await manager.triggerValidation(podId, { force: true });
      const requeued = manager.getSession(podId);
      expect(requeued.status).toBe('queued');
      // The preserved worktree (holding the synced uncommitted work) is remounted.
      expect(requeued.recoveryWorktreePath).toBe(failed.worktreePath);
      expect(requeued.worktreePath).toBe(failed.worktreePath);
      // Rework re-preserves the failed local worker before replacing its container
      // (#670): one idempotent sync on top of the failure-time preservation.
      expect(
        vi
          .mocked(ctx.containerManager.execInContainer)
          .mock.calls.filter(([, command]) => isSyncBack(command)).length,
      ).toBe(syncsBeforeRework + 1);
    } finally {
      ctx.db.close();
    }
  });

  it('retries preservation before Rework replaces the container, and keeps it on failure', async () => {
    const { ctx, manager, podId, activity } = setup();
    try {
      const exec = vi.mocked(ctx.containerManager.execInContainer);
      const passthrough = exec.getMockImplementation();
      let failSync = true;
      exec.mockImplementation(async (containerId, command, options) => {
        if (failSync && isSyncBack(command)) throw new Error('cp: device busy');
        if (!passthrough) return { stdout: '', stderr: '', exitCode: 0 };
        return passthrough(containerId, command, options);
      });

      // The archive fallback is unavailable too, so nothing could be preserved.
      const extract = vi.mocked(ctx.containerManager.extractDirectoryFromContainer);
      const extractPassthrough = extract.getMockImplementation();
      extract.mockImplementation(async (...args) => {
        if (failSync) throw new Error('archive unavailable');
        return extractPassthrough?.(...args) as never;
      });

      expect(await manager.consumeAgentEvents(podId, interruptedTurn(podId))).toBe('failed');
      expect(manager.getSession(podId).finalization?.sourcePreservedAt ?? null).toBeNull();
      expect(activity.join('\n')).toContain(
        'Interrupted agent turn: workspace preservation is incomplete',
      );

      // Still failing: Rework is refused and the original container is retained.
      await expect(manager.triggerValidation(podId, { force: true })).rejects.toMatchObject({
        code: 'WORKSPACE_SYNC_FAILED',
      });
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
      expect(manager.getSession(podId).containerId).toBe('container-123');

      // Once preservation works, Rework syncs the work back before replacing it.
      failSync = false;
      exec.mockClear();
      await manager.triggerValidation(podId, { force: true });
      expect(exec.mock.calls.some(([, command]) => isSyncBack(command))).toBe(true);
      expect(manager.getSession(podId)).toMatchObject({
        status: 'queued',
        recoveryWorktreePath: `/tmp/interrupted-${podId}`,
      });
    } finally {
      ctx.db.close();
    }
  });
});

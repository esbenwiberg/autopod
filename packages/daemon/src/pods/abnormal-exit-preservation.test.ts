import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent } from '../interfaces/index.js';
import {
  completeEvent,
  createMockRuntime,
  createTestContext,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

/**
 * #670: a worker that ends abnormally must not lose uncommitted/untracked
 * source that exists only in its container's /workspace overlay.
 */
const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fatal = (
  category: 'unknown' | 'quota_exhausted' | 'provider_unavailable',
  message = 'Provider failed mid-implementation',
): RuntimeEvent => ({
  type: 'error',
  timestamp: new Date().toISOString(),
  fatal: true,
  message,
  classification: { category, definitive: false, sanitizedMessage: message },
});

/**
 * A pod whose container sync-back copies the container-only edits (a modified
 * tracked file and a new untracked file) into a real host worktree directory.
 */
function setup(events: () => AsyncGenerator<RuntimeEvent>, syncFails = false) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'abnormal-exit-'));
  cleanups.push(worktree);
  fs.writeFileSync(path.join(worktree, 'phase1.ts'), 'committed phase 1\n');
  const ctx = createTestContext({
    runtime: createMockRuntime({ spawn: vi.fn(events) }),
  });
  vi.mocked(ctx.worktreeManager.create).mockResolvedValue({
    worktreePath: worktree,
    bareRepoPath: '/tmp/bare/abnormal.git',
    startCommitSha: 'abc1234567890abcdef1234567890abcdef1234',
  });
  const syncCalls: string[] = [];
  const defaultExec = vi.mocked(ctx.containerManager.execInContainer).getMockImplementation();
  vi.mocked(ctx.containerManager.execInContainer).mockImplementation(
    async (containerId, command, options) => {
      if (command[2]?.includes('.autopod-sync-')) {
        syncCalls.push(containerId);
        if (syncFails) return { stdout: '', stderr: 'disk full', exitCode: 1 };
        fs.writeFileSync(path.join(worktree, 'phase1.ts'), 'phase 1 + uncommitted edit\n');
        fs.writeFileSync(path.join(worktree, 'phase2-snapshot.ts'), 'untracked phase 2\n');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (!defaultExec) return { stdout: '', stderr: '', exitCode: 0 };
      return defaultExec(containerId, command, options);
    },
  );
  if (syncFails)
    vi.mocked(ctx.containerManager.extractDirectoryFromContainer).mockRejectedValue(
      new Error('archive unavailable'),
    );
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Implement phase 2' },
    'operator',
  );
  return { ctx, manager, pod, worktree, syncCalls };
}

function expectPreservedTree(worktree: string): void {
  expect(fs.readFileSync(path.join(worktree, 'phase1.ts'), 'utf8')).toBe(
    'phase 1 + uncommitted edit\n',
  );
  expect(fs.readFileSync(path.join(worktree, 'phase2-snapshot.ts'), 'utf8')).toBe(
    'untracked phase 2\n',
  );
}

describe('workspace preservation on abnormal worker exit (#670)', () => {
  it.each([
    ['unknown runtime error', () => fatal('unknown')],
    ['non-definitive quota failure', () => fatal('quota_exhausted', "You've hit your limit")],
  ] as const)('preserves container-only source after a fatal %s and records Source saved', async (_label, event) => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      yield event();
    });
    await f.manager.processPod(f.pod.id);
    const failed = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(failed.status).toBe('failed');
    expect(f.syncCalls).toEqual(['container-123']);
    expectPreservedTree(f.worktree);
    expect(failed.finalization?.sourcePreservedAt).toEqual(expect.any(String));
    expect(failed.failureReason).not.toContain(WORKSPACE_PRESERVATION_FAILED);
    // Preservation never removes the original container.
    expect(failed.containerId).toBe('container-123');
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
  });

  it('preserves through the provider-limit pause path before the container is torn down', async () => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        fatal: true,
        message: "You've hit your 5-hour limit",
        classification: {
          category: 'quota_exhausted',
          definitive: true,
          sanitizedMessage: "You've hit your 5-hour limit",
        },
      };
    });
    let treeAtKill = false;
    vi.mocked(f.ctx.containerManager.kill).mockImplementation(async () => {
      treeAtKill = fs.existsSync(path.join(f.worktree, 'phase2-snapshot.ts'));
    });
    await f.manager.processPod(f.pod.id);
    const paused = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'provider_limit' });
    expect(f.syncCalls).toEqual(['container-123']);
    expect(treeAtKill).toBe(true);
    expectPreservedTree(f.worktree);
    expect(paused.finalization?.sourcePreservedAt).toEqual(expect.any(String));
  });

  it('preserves when a fatal error arrives after a complete event in the same run', async () => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      yield completeEvent('Turn ended while background tests were still running');
      yield fatal('unknown', 'Worker turn was interrupted before reporting');
    });
    await f.manager.processPod(f.pod.id);
    const failed = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(failed.status).toBe('failed');
    expectPreservedTree(f.worktree);
    expect(failed.finalization?.agentSettledAt).toEqual(expect.any(String));
    expect(failed.finalization?.sourcePreservedAt).toEqual(expect.any(String));
    expect(failed.containerId).toBe('container-123');
  });

  it('preserves after a thrown runtime error', async () => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      throw new Error('Runtime process killed');
    });
    await f.manager.processPod(f.pod.id);
    const failed = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(failed.status).toBe('failed');
    expectPreservedTree(f.worktree);
    expect(failed.finalization?.sourcePreservedAt).toEqual(expect.any(String));
  });

  it('a following Rework starts from the preserved tree and syncs before teardown', async () => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      yield fatal('unknown');
    });
    await f.manager.processPod(f.pod.id);
    f.ctx.podRepo.workerRetries?.authorize(
      f.pod.id,
      'rework-after-provider-failure',
      'Provider reset; continue from preserved source',
      { type: 'human', userId: 'operator' },
    );
    const order: string[] = [];
    vi.mocked(f.ctx.containerManager.kill).mockImplementation(async () => {
      order.push('kill');
    });
    const syncsBefore = f.syncCalls.length;
    await f.manager.triggerValidation(f.pod.id, { force: true });
    order.unshift(...Array(f.syncCalls.length - syncsBefore).fill('sync'));
    expect(order).toEqual(['sync', 'kill']);
    const queued = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(queued).toMatchObject({
      status: 'queued',
      containerId: null,
      recoveryWorktreePath: f.worktree,
    });
    expectPreservedTree(f.worktree);
  });

  it('does not re-sync a worker that completed and failed later in validation', async () => {
    const f = setup(async function* () {
      yield completeEvent('Done');
    });
    f.ctx.podRepo.update(f.pod.id, {
      status: 'running',
      containerId: 'container-123',
      worktreePath: f.worktree,
    });
    expect(
      await f.manager.consumeAgentEvents(
        f.pod.id,
        (async function* () {
          yield completeEvent('Done');
        })(),
      ),
    ).toBe('completed');
    const settled = f.ctx.podRepo.getOrThrow(f.pod.id);
    f.ctx.podRepo.completionJournal?.mark(settled, 'finalizing');
    f.ctx.podRepo.update(f.pod.id, { status: 'failed' });
    await f.manager.triggerValidation(f.pod.id, { force: true });
    expect(f.syncCalls).toEqual([]);
    expect(f.ctx.containerManager.kill).toHaveBeenCalled();
    expect(f.ctx.podRepo.getOrThrow(f.pod.id).status).toBe('queued');
  });

  it('records a failed preservation, retains the container and refuses destructive Rework', async () => {
    const f = setup(async function* () {
      yield statusEvent('Writing phase 2');
      yield fatal('unknown');
    }, true);
    await f.manager.processPod(f.pod.id);
    const failed = f.ctx.podRepo.getOrThrow(f.pod.id);
    expect(failed.status).toBe('failed');
    expect(failed.finalization?.sourcePreservedAt ?? null).toBeNull();
    expect(failed.failureReason).toContain(WORKSPACE_PRESERVATION_FAILED);
    expect(failed.failureReason).toContain('container-123 retained');
    expect(failed.failureReason).toContain(`ap rework ${f.pod.id}`);
    expect(failed.containerId).toBe('container-123');
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();

    f.ctx.podRepo.workerRetries?.authorize(
      f.pod.id,
      'rework-after-provider-failure',
      'Provider reset',
      { type: 'human', userId: 'operator' },
    );
    await expect(f.manager.triggerValidation(f.pod.id, { force: true })).rejects.toMatchObject({
      code: 'WORKSPACE_SYNC_FAILED',
    });
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.getOrThrow(f.pod.id).containerId).toBe('container-123');
  });
});

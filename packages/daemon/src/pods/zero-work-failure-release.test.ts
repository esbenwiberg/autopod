import type { RuntimeEvent } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { classifyProviderError } from '../runtimes/provider-error-classifier.js';
import { createMockRuntime, createTestContext, statusEvent } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';

const REVOKED =
  'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.';

function fatal(message: string): RuntimeEvent {
  return {
    type: 'error',
    timestamp: new Date().toISOString(),
    message,
    fatal: true,
    classification: classifyProviderError('claude', { message }),
  };
}

/** Real SQLite pod manager; only Docker, network, git and the runtime stream are faked. */
function fixture(stream: RuntimeEvent[], options: { tokenBudget?: number } = {}) {
  const runtime = createMockRuntime({
    spawn: vi.fn(async function* () {
      yield* stream;
    } as () => AsyncIterable<RuntimeEvent>),
  });
  const ctx = createTestContext({ runtime });
  // Stored profiles carry an explicit null account; provider attempts bind to it.
  const readProfile = vi.mocked(ctx.profileStore.get).getMockImplementation()!;
  vi.mocked(ctx.profileStore.get).mockImplementation((name) => ({
    ...readProfile(name),
    providerAccountId: null,
  }));
  ctx.deps.eventRepo = createEventRepository(ctx.db);
  ctx.deps.providerAttemptRepo = createProviderAttemptRepository(ctx.db);
  const destroyNetworkForPod = vi.fn(async (_podId: string) => {});
  ctx.deps.networkManager = {
    getGatewayIp: vi.fn(async () => '172.22.0.1'),
    buildNetworkConfig: vi.fn(async () => null),
    destroyNetworkForPod,
  };
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    {
      profileName: 'test-profile',
      task: 'Canary task',
      skipValidation: true,
      ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
    },
    'user-1',
  );
  return { ctx, manager, podId: pod.id, destroyNetworkForPod };
}

describe('zero-work provider account failures', () => {
  it('releases the container and network, settles zero usage and keeps the failed pod', async () => {
    const f = fixture([statusEvent('Claude pod initialized (session)'), fatal(REVOKED)], {
      tokenBudget: 400_000,
    });

    await f.manager.processPod(f.podId);

    const pod = f.manager.getSession(f.podId);
    expect(pod.status).toBe('failed');
    expect(pod.failureReason).toBe(`Provider account unavailable: ${REVOKED}`);
    expect(f.ctx.containerManager.kill).toHaveBeenCalledWith('container-123');
    expect(pod.containerId).toBeNull();
    expect(f.destroyNetworkForPod).toHaveBeenCalledWith(f.podId);
    expect(pod.worktreePath).toBe('/tmp/worktree/abc');
    expect(pod.tokenTelemetryAccuracy).toBe('complete');
    const attempts = f.ctx.deps.providerAttemptRepo!.list(f.podId);
    expect(attempts.at(-1)).toMatchObject({
      outcome: 'failed',
      classification: { category: 'auth', definitive: true },
    });
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    expect(task.budgetCheck?.status).toBe('below_recorded_limit');
    expect(task.diagnostics.join('\n')).not.toContain('agent telemetry incomplete');
  });

  it('keeps resources when the agent did any work before the account failed', async () => {
    const f = fixture([
      statusEvent('Claude pod initialized (session)'),
      {
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        tool: 'Read',
        input: { file_path: 'README.md' },
      },
      fatal(REVOKED),
    ]);

    await f.manager.processPod(f.podId);

    const pod = f.manager.getSession(f.podId);
    expect(pod.status).toBe('failed');
    expect(pod.failureReason).toBe(`Provider account unavailable: ${REVOKED}`);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.destroyNetworkForPod).not.toHaveBeenCalled();
    expect(pod.containerId).toBe('container-123');
    expect(pod.tokenTelemetryAccuracy).toBe('partial');
  });

  it('keeps resources for zero-work failures that are not provider account refusals', async () => {
    const f = fixture([fatal('Claude process exited with code 1')]);

    await f.manager.processPod(f.podId);

    const pod = f.manager.getSession(f.podId);
    expect(pod.status).toBe('failed');
    expect(pod.failureReason).toBe('Agent failed: Claude process exited with code 1');
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(pod.containerId).toBe('container-123');
    expect(pod.tokenTelemetryAccuracy).toBe('partial');
  });

  it('keeps resources when evidence of agent activity is unavailable', async () => {
    const f = fixture([fatal(REVOKED)]);
    f.ctx.deps.eventRepo = undefined;
    const manager = createPodManager(f.ctx.deps);

    await manager.processPod(f.podId);

    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(manager.getSession(f.podId).containerId).toBe('container-123');
  });

  it('keeps the container and network when a release guard refuses', async () => {
    const f = fixture([fatal(REVOKED)]);
    vi.mocked(f.ctx.containerManager.kill).mockRejectedValueOnce(new Error('docker busy'));

    await f.manager.processPod(f.podId);

    const pod = f.manager.getSession(f.podId);
    expect(pod.status).toBe('failed');
    expect(pod.containerId).toBe('container-123');
    expect(f.destroyNetworkForPod).not.toHaveBeenCalled();
  });
});

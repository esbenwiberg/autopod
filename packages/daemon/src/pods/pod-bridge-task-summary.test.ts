import type { PodBridge } from '@autopod/escalation-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { type SessionBridgeDependencies, createSessionBridge } from './pod-bridge-impl.js';
import { createPodRepository } from './pod-repository.js';

type Deps = SessionBridgeDependencies;

function buildBridge(): {
  bridge: PodBridge;
  podRepo: ReturnType<typeof createPodRepository>;
  podId: string;
  emit: ReturnType<typeof vi.fn>;
} {
  const db = createTestDb();
  insertTestProfile(db, { name: 'proj' });
  const podRepo = createPodRepository(db);
  const podId = 'sess-1';

  db.prepare(
    `INSERT INTO pods (id, profile_name, task, model, branch, user_id)
     VALUES (@id, 'proj', 't', 'opus', 'main', 'u')`,
  ).run({ id: podId });

  const podManager = {
    touchHeartbeat: vi.fn(),
  } as unknown as Deps['podManager'];

  const emit = vi.fn();
  const eventBus = { emit, subscribe: vi.fn() } as unknown as Deps['eventBus'];

  const stub = {} as never;
  const bridge = createSessionBridge({
    podManager,
    podRepo,
    eventBus,
    escalationRepo: stub,
    nudgeRepo: stub,
    profileStore: stub,
    containerManagerFactory: stub,
    pendingRequestsByPod: new Map(),
    logger,
  });

  return { bridge, podRepo, podId, emit };
}

describe('PodBridge.reportTaskSummary — lock-on-first-write', () => {
  it('writes the task summary on the first call', () => {
    const { bridge, podRepo, podId } = buildBridge();

    bridge.reportTaskSummary(podId, 'first summary', [], 'how-1');

    const pod = podRepo.getOrThrow(podId);
    expect(pod.taskSummary?.actualSummary).toBe('first summary');
    expect(pod.taskSummary?.how).toBe('how-1');
  });

  it('does NOT overwrite an existing task summary on a second call', () => {
    const { bridge, podRepo, podId } = buildBridge();

    bridge.reportTaskSummary(podId, 'original summary', [], 'how-original');
    bridge.reportTaskSummary(podId, 'fix-cycle summary', [], 'how-fix');

    const pod = podRepo.getOrThrow(podId);
    expect(pod.taskSummary?.actualSummary).toBe('original summary');
    expect(pod.taskSummary?.how).toBe('how-original');
  });

  it('still emits the task_summary event on a locked re-report', () => {
    const { bridge, podId, emit } = buildBridge();

    bridge.reportTaskSummary(podId, 'original', [], 'how');
    emit.mockClear();
    bridge.reportTaskSummary(podId, 'second', [], 'how-2');

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]?.[0] as { event?: { type?: string; actualSummary?: string } };
    expect(arg.event?.type).toBe('task_summary');
    // The event reflects what the agent sent, even though the DB is locked —
    // activity log shows the agent did call the tool.
    expect(arg.event?.actualSummary).toBe('second');
  });
});

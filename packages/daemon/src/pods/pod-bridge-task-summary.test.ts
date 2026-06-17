import type { PodBridge } from '@autopod/escalation-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';
import { type SessionBridgeDependencies, createSessionBridge } from './pod-bridge-impl.js';
import { createPodRepository } from './pod-repository.js';

type Deps = SessionBridgeDependencies;

function buildBridge(): {
  bridge: PodBridge;
  podRepo: ReturnType<typeof createPodRepository>;
  memoryRepo: ReturnType<typeof createMemoryRepository>;
  usageRepo: ReturnType<typeof createMemoryUsageRepository>;
  podId: string;
  emit: ReturnType<typeof vi.fn>;
} {
  const db = createTestDb();
  insertTestProfile(db, { name: 'proj' });
  const podRepo = createPodRepository(db);
  const memoryRepo = createMemoryRepository(db);
  const usageRepo = createMemoryUsageRepository(db);
  const podId = 'sess-1';

  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, branch, user_id)
     VALUES (@id, 'proj', 't', 'running', 'opus', 'main', 'u')`,
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
    memoryRepo,
    memoryUsageRepo: usageRepo,
    containerManagerFactory: stub,
    pendingRequestsByPod: new Map(),
    logger,
  });

  return { bridge, podRepo, memoryRepo, usageRepo, podId, emit };
}

function insertSelectedMemory(
  memoryRepo: ReturnType<typeof createMemoryRepository>,
  usageRepo: ReturnType<typeof createMemoryUsageRepository>,
  podId: string,
): string {
  const memoryId = `mem-${podId}`;
  memoryRepo.insert({
    id: memoryId,
    scope: 'profile',
    scopeId: 'proj',
    path: '/memory.md',
    content: 'memory content',
    rationale: null,
    kind: null,
    tags: [],
    appliesWhen: null,
    avoidWhen: null,
    confidence: null,
    sourceEvidence: [],
    impactSummary: null,
    approved: true,
    createdByPodId: null,
  });
  usageRepo.record({
    id: `${memoryId}-selected`,
    memoryId,
    podId,
    kind: 'selected',
    outcome: null,
    reason: null,
    relevanceReason: 'selected for test',
  });
  usageRepo.record({
    id: `${memoryId}-injected`,
    memoryId,
    podId,
    kind: 'injected',
    outcome: null,
    reason: null,
    relevanceReason: 'injected for test',
  });
  return memoryId;
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

  it('preserves fact deviations reported after the task summary is locked', () => {
    const { bridge, podRepo, podId } = buildBridge();
    const factDeviations = [
      {
        factId: 'fact-swift-only',
        action: 'waive' as const,
        reason: 'The artifact was changed, but the verifier image does not include Swift.',
        whyImpossible: 'swift is not installed in the validation container.',
      },
    ];

    bridge.reportTaskSummary(podId, 'original summary', [], 'how-original');
    bridge.reportTaskSummary(podId, 'fix-cycle summary', [], 'how-fix', undefined, factDeviations);

    const pod = podRepo.getOrThrow(podId);
    expect(pod.taskSummary?.actualSummary).toBe('original summary');
    expect(pod.taskSummary?.factDeviations).toEqual(factDeviations);
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

  it('updates memory outcomes on a locked re-report while preserving original summary text', () => {
    const { bridge, podRepo, memoryRepo, usageRepo, podId } = buildBridge();
    const memoryId = insertSelectedMemory(memoryRepo, usageRepo, podId);

    bridge.reportTaskSummary(podId, 'original summary', [], 'how-original', undefined, undefined, [
      { memoryId, outcome: 'applied', reason: 'Used the convention.' },
    ]);
    bridge.reportTaskSummary(podId, 'fix-cycle summary', [], 'how-fix', undefined, undefined, [
      { memoryId, outcome: 'not_applicable', reason: 'Fix cycle did not touch it.' },
    ]);

    const pod = podRepo.getOrThrow(podId);
    expect(pod.taskSummary?.actualSummary).toBe('original summary');
    expect(pod.taskSummary?.how).toBe('how-original');
    expect(pod.taskSummary?.memoryOutcomes).toEqual([
      { memoryId, outcome: 'not_applicable', reason: 'Fix cycle did not touch it.' },
    ]);
  });

  it('updates review feedback responses on a locked re-report while preserving original summary text', () => {
    const { bridge, podRepo, podId } = buildBridge();
    const responses = [
      {
        feedbackId: 'gh-comment-123',
        outcome: 'fixed' as const,
        response: 'Added the missing null guard.',
      },
    ];

    bridge.reportTaskSummary(podId, 'original summary', [], 'how-original');
    bridge.reportTaskSummary(
      podId,
      'fix-cycle summary',
      [],
      'how-fix',
      undefined,
      undefined,
      undefined,
      responses,
    );

    const pod = podRepo.getOrThrow(podId);
    expect(pod.taskSummary?.actualSummary).toBe('original summary');
    expect(pod.taskSummary?.how).toBe('how-original');
    expect(pod.taskSummary?.reviewFeedbackResponses).toEqual(responses);
  });

  it('rejects stale agent progress and summaries after the pod leaves running state', () => {
    const { bridge, podRepo, podId, emit } = buildBridge();

    podRepo.update(podId, { status: 'validating' });

    expect(() => bridge.reportProgress(podId, 'Wrap-up', 'Late progress', 4, 4)).toThrow(
      /only accepted while the pod is running/,
    );
    expect(() => bridge.reportTaskSummary(podId, 'late summary', [])).toThrow(
      /only accepted while the pod is running/,
    );

    expect(podRepo.getOrThrow(podId).taskSummary).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('PodBridge.reportProgress — plan alignment', () => {
  it('persists aligned progress when a plan exists', () => {
    const { bridge, podRepo, podId, emit } = buildBridge();
    podRepo.update(podId, {
      plan: { summary: 'Do three things', steps: ['One', 'Two', 'Three'] },
    });

    bridge.reportProgress(podId, 'Two', 'Working on step two', 2, 3);

    expect(podRepo.getOrThrow(podId).progress).toEqual({
      phase: 'Two',
      description: 'Working on step two',
      currentPhase: 2,
      totalPhases: 3,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'progress',
          currentPhase: 2,
          totalPhases: 3,
        }),
      }),
    );
  });

  it('rejects progress whose total does not match the plan step count', () => {
    const { bridge, podRepo, podId, emit } = buildBridge();
    podRepo.update(podId, {
      plan: { summary: 'Do ten things', steps: Array.from({ length: 10 }, (_, i) => `Step ${i}`) },
    });

    expect(() => bridge.reportProgress(podId, 'Three', 'Working', 3, 4)).toThrow(
      /must equal the reported plan step count \(10\)/,
    );

    expect(podRepo.getOrThrow(podId).progress).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects progress whose current phase is outside the plan steps', () => {
    const { bridge, podRepo, podId, emit } = buildBridge();
    podRepo.update(podId, {
      plan: { summary: 'Do ten things', steps: Array.from({ length: 10 }, (_, i) => `Step ${i}`) },
    });

    expect(() => bridge.reportProgress(podId, 'Eleven', 'Working', 11, 10)).toThrow(
      /cannot exceed totalPhases/,
    );

    expect(podRepo.getOrThrow(podId).progress).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('accepts normal progress before a plan exists', () => {
    const { bridge, podRepo, podId } = buildBridge();

    bridge.reportProgress(podId, 'Explore', 'Reading the repo', 1, 3);

    expect(podRepo.getOrThrow(podId).progress).toEqual({
      phase: 'Explore',
      description: 'Reading the repo',
      currentPhase: 1,
      totalPhases: 3,
    });
  });

  it('rejects impossible progress before a plan exists', () => {
    const { bridge, podRepo, podId, emit } = buildBridge();

    expect(() => bridge.reportProgress(podId, 'Explore', 'Reading the repo', 4, 3)).toThrow(
      /currentPhase \(4\) cannot exceed totalPhases \(3\)/,
    );

    expect(podRepo.getOrThrow(podId).progress).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

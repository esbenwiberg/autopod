import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PodBridge } from '@autopod/escalation-mcp';
import type { DeferredCheck } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { assertNoInfrastructureBlocker } from './escalation-coordinator.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';
import { createSessionBridge, type SessionBridgeDependencies } from './pod-bridge-impl.js';
import { createPodRepository } from './pod-repository.js';

type Deps = SessionBridgeDependencies;

function buildBridge(): {
  bridge: PodBridge;
  db: ReturnType<typeof createTestDb>;
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

  return { bridge, db, podRepo, memoryRepo, usageRepo, podId, emit };
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

  it('preserves a late task summary while human input remains outstanding', () => {
    const { bridge, podRepo, podId } = buildBridge();
    podRepo.update(podId, { status: 'awaiting_input' });
    expect(() =>
      bridge.reportTaskSummary(podId, 'Collected findings; human triage pending', []),
    ).not.toThrow();
    expect(podRepo.getOrThrow(podId).taskSummary?.actualSummary).toBe(
      'Collected findings; human triage pending',
    );
    expect(podRepo.getOrThrow(podId).status).toBe('awaiting_input');
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

describe('PodBridge deferred verification context', () => {
  const mac: DeferredCheck = {
    id: 'mac-tests',
    check: 'xcodebuild test',
    reason: 'Linux worker',
    expectedExecutor: 'Mac',
  };
  function report(bridge: PodBridge, podId: string, checks?: DeferredCheck[]) {
    bridge.reportTaskSummary(
      podId,
      'Implemented; Mac verification NOT-RUN',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      checks,
    );
  }

  it('preserves replayed, omitted and empty entries through a database reopen without a hold', () => {
    const { bridge, db, podRepo, podId, emit } = buildBridge();
    const directory = mkdtempSync(join(tmpdir(), 'deferred-checks-'));
    try {
      const generation = podRepo.getOrThrow(podId).lifecycleGeneration;
      report(bridge, podId, [mac]);
      report(bridge, podId, [mac, mac]);
      report(bridge, podId, []);
      report(bridge, podId);
      const expected = [{ ...mac, lifecycleGeneration: generation }];
      const pod = podRepo.getOrThrow(podId);
      expect(pod.taskSummary?.deferredChecks).toEqual(expected);
      expect(pod.status).toBe('running');
      expect(pod.pendingEscalation).toBeNull();
      expect(pod.failureReason).toBeNull();
      expect(pod.escalationCount).toBe(0);
      expect(podRepo.hasInfrastructureBlocker?.(podId)).toBe(false);
      expect(createEscalationRepository(db).listBySession(podId)).toEqual([]);
      expect(emit.mock.lastCall?.[0].event.deferredChecks).toEqual(expected);
      const file = join(directory, 'state.db');
      writeFileSync(file, db.serialize());
      const reopened = createDatabase(file, logger);
      try {
        expect(createPodRepository(reopened).getOrThrow(podId).taskSummary?.deferredChecks).toEqual(
          expected,
        );
      } finally {
        reopened.close();
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('appends after a legacy locked summary, rejecting conflicting IDs atomically', () => {
    const { bridge, db, podRepo, podId, emit } = buildBridge();
    try {
      bridge.reportTaskSummary(podId, 'Original', []);
      expect(podRepo.getOrThrow(podId).taskSummary).not.toHaveProperty('deferredChecks');
      report(bridge, podId, [mac]);
      const before = podRepo.getOrThrow(podId);
      emit.mockClear();
      expect(() =>
        report(bridge, podId, [
          { ...mac, id: 'new-check' },
          { ...mac, reason: 'Claimed fixed' },
        ]),
      ).toThrow(/already has different content/);
      expect(podRepo.getOrThrow(podId)).toEqual(before);
      expect(emit).not.toHaveBeenCalled();
      report(bridge, podId, [{ ...mac, id: 'another-check' }]);
      expect(podRepo.getOrThrow(podId).taskSummary?.actualSummary).toBe('Original');
      expect(podRepo.getOrThrow(podId).taskSummary?.deferredChecks).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('validates fact references without changing authoritative facts or decisions', () => {
    const { bridge, db, podRepo, podId } = buildBridge();
    try {
      expect(() => report(bridge, podId, [{ ...mac, requiredFactId: 'unknown' }])).toThrow(
        /unknown required fact/,
      );
      expect(podRepo.getOrThrow(podId).taskSummary).toBeNull();
      const contract = {
        contractVersion: 1 as const,
        title: 'Mac',
        dependsOn: [],
        scenarios: [],
        humanReview: [],
        requiredFacts: [
          {
            id: 'mac-fact',
            proves: [],
            kind: 'unit-test' as const,
            artifact: { path: 'packages/desktop/Tests/test.swift', change: 'update' as const },
            command: 'xcodebuild test',
          },
        ],
      };
      podRepo.update(podId, { contract });
      report(bridge, podId, [{ ...mac, requiredFactId: 'mac-fact' }]);
      expect(podRepo.getOrThrow(podId).contract).toEqual(contract);
      expect(podRepo.getOrThrow(podId).taskSummary?.factDeviations).toBeUndefined();
      expect(podRepo.getOrThrow(podId).lastValidationResult).toBeNull();
    } finally {
      db.close();
    }
  });

  it.each([
    'status',
    'required',
    'actor',
    'decision',
    'lifecycleGeneration',
    'repaired',
  ])('rejects direct worker authority field %s before persistence', (field) => {
    const { bridge, db, podRepo, podId, emit } = buildBridge();
    try {
      expect(() => report(bridge, podId, [{ ...mac, [field]: 'passed' }])).toThrow();
      expect(podRepo.getOrThrow(podId).taskSummary).toBeNull();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('bounds lifetime count and strings at the direct write boundary', () => {
    const { bridge, db, podRepo, podId } = buildBridge();
    try {
      for (const invalid of [
        Array(51).fill(mac),
        [{ ...mac, check: 'x'.repeat(2001) }],
        [{ ...mac, id: ' ' }],
      ]) {
        expect(() => report(bridge, podId, invalid)).toThrow();
      }
      report(
        bridge,
        podId,
        Array.from({ length: 50 }, (_, index) => ({ ...mac, id: `check-${index}` })),
      );
      expect(() => report(bridge, podId, [mac])).toThrow(/At most 50/);
      report(bridge, podId, []);
      expect(podRepo.getOrThrow(podId).taskSummary?.deferredChecks).toHaveLength(50);
    } finally {
      db.close();
    }
  });

  it('retains original lifecycle attribution on replay and never clears a mixed real blocker', () => {
    const { bridge, db, podRepo, podId } = buildBridge();
    try {
      const generation = podRepo.getOrThrow(podId).lifecycleGeneration;
      report(bridge, podId, [mac]);
      podRepo.incrementLifecycleGeneration(podId);
      report(bridge, podId, [mac]);
      const current = podRepo.getOrThrow(podId);
      expect(current.taskSummary?.deferredChecks?.[0]?.lifecycleGeneration).toBe(generation);
      createEscalationRepository(db).insert({
        id: 'real-blocker',
        podId,
        type: 'report_blocker',
        timestamp: new Date().toISOString(),
        response: null,
        payload: {
          kind: 'infrastructure',
          lifecycleGeneration: current.lifecycleGeneration,
          requiresResponse: false,
          description: 'Required private source missing',
          attempted: [],
          needs: 'Staged input',
        },
      });
      for (const checks of [undefined, [], [mac]]) report(bridge, podId, checks);
      expect(podRepo.hasInfrastructureBlocker?.(podId)).toBe(true);
      expect(() => assertNoInfrastructureBlocker(podRepo, podId)).toThrow(
        /Infrastructure remains blocked/,
      );
      expect(createEscalationRepository(db).getOrThrow('real-blocker').response).toBeNull();
    } finally {
      db.close();
    }
  });
});

import type { PodBridge } from '@autopod/escalation-mcp';
import type { PodStatus, TaskSummary } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';
import {
  type SessionBridgeDependencies,
  __resetSuggestBudgetForTests,
  createSessionBridge,
} from './pod-bridge-impl.js';

type StubSession = { id: string; profileName: string; status?: PodStatus };
type Deps = SessionBridgeDependencies;

function buildBridgeWithMemory(pods: StubSession[]): {
  bridge: PodBridge;
  memoryRepo: ReturnType<typeof createMemoryRepository>;
  usageRepo: ReturnType<typeof createMemoryUsageRepository>;
} {
  const db = createTestDb();
  const memoryRepo = createMemoryRepository(db);
  const usageRepo = createMemoryUsageRepository(db);

  // Seed FK targets: memory_entries.created_by_pod_id → pods(id) → profiles(name).
  const seededProfiles = new Set<string>();
  for (const s of pods) {
    const status = s.status ?? 'running';
    if (!seededProfiles.has(s.profileName)) {
      insertTestProfile(db, { name: s.profileName });
      seededProfiles.add(s.profileName);
    }
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, branch, user_id, status)
       VALUES (@id, @profile, 't', 'opus', 'main', 'u', @status)`,
    ).run({ id: s.id, profile: s.profileName, status });
  }

  const podManager = {
    getSession: vi.fn((id: string) => {
      const pod = pods.find((s) => s.id === id);
      if (!pod) throw new Error(`unknown pod: ${id}`);
      return { ...pod, status: pod.status ?? 'running' };
    }),
    touchHeartbeat: vi.fn(),
  } as unknown as Deps['podManager'];

  const eventBus = {
    emit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as Deps['eventBus'];
  const podsById = new Map(
    pods.map((pod) => [
      pod.id,
      { ...pod, status: 'running', taskSummary: null as TaskSummary | null },
    ]),
  );
  const podRepo = {
    update: vi.fn((id: string, updates: Record<string, unknown>) => {
      const existing = podsById.get(id);
      if (existing) podsById.set(id, { ...existing, ...updates });
    }),
    getOrThrow: vi.fn((id: string) => {
      const pod = podsById.get(id);
      if (!pod) throw new Error(`unknown pod: ${id}`);
      return pod;
    }),
  } as unknown as Deps['podRepo'];

  // The memory code paths under test only touch podManager, eventBus,
  // memoryRepo and logger — the other deps can be empty-object stubs.
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
    containerManagerFactory: (() => stub) as unknown as Deps['containerManagerFactory'],
    pendingRequestsByPod: new Map(),
    logger,
  });
  return { bridge, memoryRepo, usageRepo };
}

function buildBridge(pods: StubSession[]): PodBridge {
  return buildBridgeWithMemory(pods).bridge;
}

function insertApprovedMemory(
  memoryRepo: ReturnType<typeof createMemoryRepository>,
  id: string,
  scopeId = 'proj',
): void {
  memoryRepo.insert({
    id,
    scope: 'profile',
    scopeId,
    path: `/${id}.md`,
    content: `${id} content`,
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
}

function markSelected(
  usageRepo: ReturnType<typeof createMemoryUsageRepository>,
  podId: string,
  memoryId: string,
): void {
  usageRepo.record({
    id: `${podId}-${memoryId}-selected`,
    memoryId,
    podId,
    kind: 'selected',
    outcome: null,
    reason: null,
    relevanceReason: 'selected for test',
  });
  usageRepo.record({
    id: `${podId}-${memoryId}-injected`,
    memoryId,
    podId,
    kind: 'injected',
    outcome: null,
    reason: null,
    relevanceReason: 'injected for test',
  });
}

describe('pod bridge — memory scope enforcement (F2a)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  const RATIONALE = 'a future pod doing X on this profile would waste >5 min hitting Y';

  it('rejects cross-pod reads of pod-scoped memory', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'pod', '/notes/a.md', 'secret-A', RATIONALE);

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this pod/);
  });

  it('allows a pod to read its own pod-scoped memory', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'pod', '/notes/a.md', 'own-A', RATIONALE);

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.content).toBe('own-A');
  });

  it('rejects cross-profile reads of profile-scoped memory', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj-A' },
      { id: 'sess-b', profileName: 'proj-B' },
    ]);
    // Suggestion for proj-A — unapproved, belongs to sess-a
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'profile-A', RATIONALE);

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this pod/);
  });

  it('rejects reads of unapproved suggestions from other pods, even in the same profile', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'pending', RATIONALE);

    // Same profile, so scope check would pass — but entry is unapproved and created by sess-a
    expect(() => bridge.readMemory('sess-b', id)).toThrow(/pending approval/);
  });

  it('allows a pod to read its own unapproved suggestion', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'mine', RATIONALE);

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.content).toBe('mine');
    expect(entry.approved).toBe(false);
  });
});

describe('pod bridge — memory_suggest rationale', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('persists rationale when provided', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory(
      'sess-a',
      'pod',
      '/notes/why.md',
      'use --force-fresh flag',
      'default caching hides the race condition we hit today',
    );

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.rationale).toBe('default caching hides the race condition we hit today');
  });

  it('rejects empty rationale', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    expect(() => bridge.suggestMemory('sess-a', 'pod', '/notes/x.md', 'content', '')).toThrow(
      /rationale is required/i,
    );
  });

  it('rejects whitespace-only rationale', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    expect(() =>
      bridge.suggestMemory('sess-a', 'pod', '/notes/x.md', 'content', '   \n  '),
    ).toThrow(/rationale is required/i);
  });

  it('trims rationale whitespace before persisting', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory(
      'sess-a',
      'pod',
      '/notes/trim.md',
      'content',
      '  meaningful reason  ',
    );

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.rationale).toBe('meaningful reason');
  });
});

describe('pod bridge — memory_suggest rate limit (F2b)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  const RATIONALE = 'a future pod doing X on this profile would waste >5 min hitting Y';

  it('throws once the non-pod suggestion budget is exhausted', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 5; i++) {
      bridge.suggestMemory('sess-a', 'profile', `/p${i}.md`, `c${i}`, RATIONALE);
    }
    expect(() => bridge.suggestMemory('sess-a', 'profile', '/p-over.md', 'c', RATIONALE)).toThrow(
      /rate limit exceeded/i,
    );
  });

  it('pod-scoped suggestions are not rate-limited', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 20; i++) {
      bridge.suggestMemory('sess-a', 'pod', `/n${i}.md`, `c${i}`, RATIONALE);
    }
    // Should not throw — pod scope is self-contained
    expect(() => bridge.suggestMemory('sess-a', 'pod', '/final.md', 'c', RATIONALE)).not.toThrow();
  });

  it('budgets are tracked per pod', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);

    for (let i = 0; i < 5; i++) {
      bridge.suggestMemory('sess-a', 'profile', `/a${i}.md`, 'c', RATIONALE);
    }
    // sess-b still has full budget
    expect(() => bridge.suggestMemory('sess-b', 'profile', '/b0.md', 'c', RATIONALE)).not.toThrow();
  });
});

describe('pod bridge — memory usage reporting evidence', () => {
  it('rejects report_plan when selected memories exist and memory intent is missing', () => {
    const { bridge, memoryRepo, usageRepo } = buildBridgeWithMemory([
      { id: 'sess-a', profileName: 'proj' },
    ]);
    insertApprovedMemory(memoryRepo, 'mem-a');
    markSelected(usageRepo, 'sess-a', 'mem-a');

    expect(() => bridge.reportPlan('sess-a', 'Do work', ['Step 1'])).toThrow(/memoryIntents/i);
  });

  it('rejects report_task_summary when selected memories exist and final outcome is missing', () => {
    const { bridge, memoryRepo, usageRepo } = buildBridgeWithMemory([
      { id: 'sess-a', profileName: 'proj' },
    ]);
    insertApprovedMemory(memoryRepo, 'mem-a');
    markSelected(usageRepo, 'sess-a', 'mem-a');

    expect(() => bridge.reportTaskSummary('sess-a', 'Done', [])).toThrow(/memoryOutcomes/i);
  });

  it('accepts valid retry after rejected memory usage reporting and records evidence', () => {
    const { bridge, memoryRepo, usageRepo } = buildBridgeWithMemory([
      { id: 'sess-a', profileName: 'proj' },
    ]);
    insertApprovedMemory(memoryRepo, 'mem-a');
    markSelected(usageRepo, 'sess-a', 'mem-a');
    expect(() => bridge.reportPlan('sess-a', 'Do work', ['Step 1'])).toThrow(/memoryIntents/i);

    bridge.reportPlan(
      'sess-a',
      'Do work',
      ['Step 1'],
      [{ memoryId: 'mem-a', reason: 'Apply its convention.' }],
    );
    bridge.reportTaskSummary('sess-a', 'Done', [], undefined, undefined, undefined, [
      { memoryId: 'mem-a', outcome: 'applied', reason: 'Used the convention.' },
    ]);

    const events = usageRepo.listByPod('sess-a');
    expect(events.find((event) => event.kind === 'plan_reported')).toMatchObject({
      memoryId: 'mem-a',
      outcome: 'intended',
      reason: 'Apply its convention.',
    });
    expect(events.find((event) => event.kind === 'summary_reported')).toMatchObject({
      memoryId: 'mem-a',
      outcome: 'applied',
      reason: 'Used the convention.',
    });
  });

  it('records read and search evidence daemon-side from memory tools', () => {
    const { bridge, memoryRepo, usageRepo } = buildBridgeWithMemory([
      { id: 'sess-a', profileName: 'proj' },
    ]);
    insertApprovedMemory(memoryRepo, 'mem-a');

    bridge.readMemory('sess-a', 'mem-a');
    bridge.searchMemories('sess-a', 'profile', 'content');

    const events = usageRepo.listByPod('sess-a');
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['read', 'searched']));
    expect(events.find((event) => event.kind === 'searched')?.reason).toContain('content');
  });

  it('records not_reported for selected memories when terminal fallback runs without summary', () => {
    const { memoryRepo, usageRepo } = buildBridgeWithMemory([
      { id: 'sess-a', profileName: 'proj' },
    ]);
    insertApprovedMemory(memoryRepo, 'mem-a');
    markSelected(usageRepo, 'sess-a', 'mem-a');

    usageRepo.recordNotReportedForPod('sess-a');

    expect(
      usageRepo.listByPod('sess-a').find((event) => event.kind === 'not_reported'),
    ).toMatchObject({
      memoryId: 'mem-a',
      outcome: null,
    });
  });

  it('does not require memory usage fields when no memories were selected', () => {
    const { bridge } = buildBridgeWithMemory([{ id: 'sess-a', profileName: 'proj' }]);

    expect(() => bridge.reportPlan('sess-a', 'Do work', ['Step 1'])).not.toThrow();
    expect(() => bridge.reportTaskSummary('sess-a', 'Done', [])).not.toThrow();
    expect(() =>
      bridge.reportPlan(
        'sess-a',
        'Do work',
        ['Step 1'],
        [{ memoryId: 'unselected', reason: 'Should not be accepted.' }],
      ),
    ).toThrow(/not selected\/injected/i);
  });
});

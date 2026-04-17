import type { PodBridge } from '@autopod/escalation-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createMemoryRepository } from './memory-repository.js';
import {
  type SessionBridgeDependencies,
  __resetSuggestBudgetForTests,
  createSessionBridge,
} from './pod-bridge-impl.js';

type StubSession = { id: string; profileName: string };
type Deps = SessionBridgeDependencies;

function buildBridge(pods: StubSession[]): PodBridge {
  const db = createTestDb();
  const memoryRepo = createMemoryRepository(db);

  // Seed FK targets: memory_entries.created_by_pod_id → pods(id) → profiles(name).
  const seededProfiles = new Set<string>();
  for (const s of pods) {
    if (!seededProfiles.has(s.profileName)) {
      insertTestProfile(db, { name: s.profileName });
      seededProfiles.add(s.profileName);
    }
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, branch, user_id)
       VALUES (@id, @profile, 't', 'opus', 'main', 'u')`,
    ).run({ id: s.id, profile: s.profileName });
  }

  const podManager = {
    getSession: vi.fn((id: string) => {
      const pod = pods.find((s) => s.id === id);
      if (!pod) throw new Error(`unknown pod: ${id}`);
      return pod;
    }),
    touchHeartbeat: vi.fn(),
  } as unknown as Deps['podManager'];

  const eventBus = {
    emit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as Deps['eventBus'];

  // The memory code paths under test only touch podManager, eventBus,
  // memoryRepo and logger — the other deps can be empty-object stubs.
  const stub = {} as never;
  return createSessionBridge({
    podManager,
    podRepo: stub,
    eventBus,
    escalationRepo: stub,
    nudgeRepo: stub,
    profileStore: stub,
    memoryRepo,
    containerManagerFactory: (() => stub) as unknown as Deps['containerManagerFactory'],
    pendingRequestsByPod: new Map(),
    logger,
  });
}

describe('pod bridge — memory scope enforcement (F2a)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('rejects cross-pod reads of pod-scoped memory', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'pod', '/notes/a.md', 'secret-A');

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this pod/);
  });

  it('allows a pod to read its own pod-scoped memory', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'pod', '/notes/a.md', 'own-A');

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.content).toBe('own-A');
  });

  it('rejects cross-profile reads of profile-scoped memory', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj-A' },
      { id: 'sess-b', profileName: 'proj-B' },
    ]);
    // Suggestion for proj-A — unapproved, belongs to sess-a
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'profile-A');

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this pod/);
  });

  it('rejects reads of unapproved suggestions from other pods, even in the same profile', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'pending');

    // Same profile, so scope check would pass — but entry is unapproved and created by sess-a
    expect(() => bridge.readMemory('sess-b', id)).toThrow(/pending approval/);
  });

  it('allows a pod to read its own unapproved suggestion', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'mine');

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

  it('defaults rationale to null when omitted', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'pod', '/notes/x.md', 'content');

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.rationale).toBeNull();
  });
});

describe('pod bridge — memory_suggest rate limit (F2b)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('throws once the non-pod suggestion budget is exhausted', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 5; i++) {
      bridge.suggestMemory('sess-a', 'profile', `/p${i}.md`, `c${i}`);
    }
    expect(() => bridge.suggestMemory('sess-a', 'profile', '/p-over.md', 'c')).toThrow(
      /rate limit exceeded/i,
    );
  });

  it('pod-scoped suggestions are not rate-limited', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 20; i++) {
      bridge.suggestMemory('sess-a', 'pod', `/n${i}.md`, `c${i}`);
    }
    // Should not throw — pod scope is self-contained
    expect(() => bridge.suggestMemory('sess-a', 'pod', '/final.md', 'c')).not.toThrow();
  });

  it('budgets are tracked per pod', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);

    for (let i = 0; i < 5; i++) {
      bridge.suggestMemory('sess-a', 'profile', `/a${i}.md`, 'c');
    }
    // sess-b still has full budget
    expect(() => bridge.suggestMemory('sess-b', 'profile', '/b0.md', 'c')).not.toThrow();
  });
});

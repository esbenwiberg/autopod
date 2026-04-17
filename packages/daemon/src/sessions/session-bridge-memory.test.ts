import type { SessionBridge } from '@autopod/escalation-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createMemoryRepository } from './memory-repository.js';
import {
  type SessionBridgeDependencies,
  __resetSuggestBudgetForTests,
  createSessionBridge,
} from './session-bridge-impl.js';

type StubSession = { id: string; profileName: string };
type Deps = SessionBridgeDependencies;

function buildBridge(sessions: StubSession[]): SessionBridge {
  const db = createTestDb();
  const memoryRepo = createMemoryRepository(db);

  // Seed FK targets: memory_entries.created_by_session_id → sessions(id) → profiles(name).
  const seededProfiles = new Set<string>();
  for (const s of sessions) {
    if (!seededProfiles.has(s.profileName)) {
      insertTestProfile(db, { name: s.profileName });
      seededProfiles.add(s.profileName);
    }
    db.prepare(
      `INSERT INTO sessions (id, profile_name, task, model, branch, user_id)
       VALUES (@id, @profile, 't', 'opus', 'main', 'u')`,
    ).run({ id: s.id, profile: s.profileName });
  }

  const sessionManager = {
    getSession: vi.fn((id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) throw new Error(`unknown session: ${id}`);
      return session;
    }),
    touchHeartbeat: vi.fn(),
  } as unknown as Deps['sessionManager'];

  const eventBus = {
    emit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as Deps['eventBus'];

  // The memory code paths under test only touch sessionManager, eventBus,
  // memoryRepo and logger — the other deps can be empty-object stubs.
  const stub = {} as never;
  return createSessionBridge({
    sessionManager,
    sessionRepo: stub,
    eventBus,
    escalationRepo: stub,
    nudgeRepo: stub,
    profileStore: stub,
    memoryRepo,
    containerManagerFactory: (() => stub) as unknown as Deps['containerManagerFactory'],
    pendingRequestsBySession: new Map(),
    logger,
  });
}

describe('session bridge — memory scope enforcement (F2a)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('rejects cross-session reads of session-scoped memory', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'session', '/notes/a.md', 'secret-A');

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this session/);
  });

  it('allows a session to read its own session-scoped memory', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'session', '/notes/a.md', 'own-A');

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

    expect(() => bridge.readMemory('sess-b', id)).toThrow(/not readable from this session/);
  });

  it('rejects reads of unapproved suggestions from other sessions, even in the same profile', () => {
    const bridge = buildBridge([
      { id: 'sess-a', profileName: 'proj' },
      { id: 'sess-b', profileName: 'proj' },
    ]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'pending');

    // Same profile, so scope check would pass — but entry is unapproved and created by sess-a
    expect(() => bridge.readMemory('sess-b', id)).toThrow(/pending approval/);
  });

  it('allows a session to read its own unapproved suggestion', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'profile', '/p.md', 'mine');

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.content).toBe('mine');
    expect(entry.approved).toBe(false);
  });
});

describe('session bridge — memory_suggest rationale', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('persists rationale when provided', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory(
      'sess-a',
      'session',
      '/notes/why.md',
      'use --force-fresh flag',
      'default caching hides the race condition we hit today',
    );

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.rationale).toBe('default caching hides the race condition we hit today');
  });

  it('defaults rationale to null when omitted', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);
    const id = bridge.suggestMemory('sess-a', 'session', '/notes/x.md', 'content');

    const entry = bridge.readMemory('sess-a', id);
    expect(entry.rationale).toBeNull();
  });
});

describe('session bridge — memory_suggest rate limit (F2b)', () => {
  beforeEach(() => {
    __resetSuggestBudgetForTests();
  });

  it('throws once the non-session suggestion budget is exhausted', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 5; i++) {
      bridge.suggestMemory('sess-a', 'profile', `/p${i}.md`, `c${i}`);
    }
    expect(() => bridge.suggestMemory('sess-a', 'profile', '/p-over.md', 'c')).toThrow(
      /rate limit exceeded/i,
    );
  });

  it('session-scoped suggestions are not rate-limited', () => {
    const bridge = buildBridge([{ id: 'sess-a', profileName: 'proj' }]);

    for (let i = 0; i < 20; i++) {
      bridge.suggestMemory('sess-a', 'session', `/n${i}.md`, `c${i}`);
    }
    // Should not throw — session scope is self-contained
    expect(() => bridge.suggestMemory('sess-a', 'session', '/final.md', 'c')).not.toThrow();
  });

  it('budgets are tracked per session', () => {
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

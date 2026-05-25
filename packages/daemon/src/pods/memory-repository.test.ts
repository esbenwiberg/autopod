import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createMemoryCandidateRepository } from './memory-candidate-repository.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';

function makeMemoryId() {
  return randomUUID();
}

describe('MemoryRepository', () => {
  let db: ReturnType<typeof createTestDb>;
  let memRepo: ReturnType<typeof createMemoryRepository>;

  beforeEach(() => {
    db = createTestDb();
    memRepo = createMemoryRepository(db);
  });

  describe('legacy-row mapping', () => {
    it('reads a row inserted without new columns and returns defaults', () => {
      const id = makeMemoryId();
      // Insert using only legacy columns — simulates a pre-migration row
      db.prepare(`
        INSERT INTO memory_entries
          (id, scope, scope_id, path, content, content_sha256, rationale, version, approved, created_by_pod_id, created_at, updated_at)
        VALUES
          (?, 'profile', 'test-profile', '/legacy.md', 'content', 'abc123', NULL, 1, 1, NULL, datetime('now'), datetime('now'))
      `).run(id);

      const entry = memRepo.getOrThrow(id);
      expect(entry.kind).toBeNull();
      expect(entry.tags).toEqual([]);
      expect(entry.appliesWhen).toBeNull();
      expect(entry.avoidWhen).toBeNull();
      expect(entry.confidence).toBeNull();
      expect(entry.sourceEvidence).toEqual([]);
      expect(entry.impactSummary).toBeNull();
    });

    it('preserves all legacy fields on read', () => {
      const id = makeMemoryId();
      db.prepare(`
        INSERT INTO memory_entries
          (id, scope, scope_id, path, content, content_sha256, rationale, version, approved, created_by_pod_id, created_at, updated_at)
        VALUES
          (?, 'global', NULL, '/global.md', 'global content', 'sha', 'rationale text', 2, 1, NULL, datetime('now'), datetime('now'))
      `).run(id);

      const entry = memRepo.getOrThrow(id);
      expect(entry.id).toBe(id);
      expect(entry.scope).toBe('global');
      expect(entry.scopeId).toBeNull();
      expect(entry.path).toBe('/global.md');
      expect(entry.content).toBe('global content');
      expect(entry.rationale).toBe('rationale text');
      expect(entry.version).toBe(2);
      expect(entry.approved).toBe(true);
      expect(entry.createdByPodId).toBeNull();
    });
  });

  describe('metadata persistence', () => {
    it('inserts and reads all new metadata fields', () => {
      const id = makeMemoryId();
      const evidence = [
        {
          podId: 'pod-1',
          signal: 'test_failure',
          excerpt: 'some excerpt',
          severity: 'high' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      memRepo.insert({
        id,
        scope: 'profile',
        scopeId: 'my-profile',
        path: '/gotchas/migrations.md',
        content: 'Never skip migrations',
        rationale: 'Burned three times',
        kind: 'gotcha',
        tags: ['migrations', 'db'],
        appliesWhen: 'working on migrations',
        avoidWhen: 'greenfield projects',
        confidence: 0.9,
        sourceEvidence: evidence,
        impactSummary: 'Saves 30 min per incident',
        approved: true,
        createdByPodId: null,
      });

      const entry = memRepo.getOrThrow(id);
      expect(entry.kind).toBe('gotcha');
      expect(entry.tags).toEqual(['migrations', 'db']);
      expect(entry.appliesWhen).toBe('working on migrations');
      expect(entry.avoidWhen).toBe('greenfield projects');
      expect(entry.confidence).toBeCloseTo(0.9);
      expect(entry.sourceEvidence).toEqual(evidence);
      expect(entry.impactSummary).toBe('Saves 30 min per incident');
    });

    it('updateMetadata increments version and persists changes', () => {
      const id = makeMemoryId();
      memRepo.insert({
        id,
        scope: 'profile',
        scopeId: 'p',
        path: '/x.md',
        content: 'original',
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

      const before = memRepo.getOrThrow(id);
      expect(before.version).toBe(1);

      memRepo.updateMetadata(id, 'updated content', {
        kind: 'convention',
        tags: ['style'],
        appliesWhen: 'always',
        avoidWhen: null,
        confidence: 0.75,
        sourceEvidence: [],
        impactSummary: 'cleaner diffs',
      });

      const after = memRepo.getOrThrow(id);
      expect(after.version).toBe(2);
      expect(after.content).toBe('updated content');
      expect(after.kind).toBe('convention');
      expect(after.tags).toEqual(['style']);
      expect(after.appliesWhen).toBe('always');
      expect(after.confidence).toBeCloseTo(0.75);
      expect(after.impactSummary).toBe('cleaner diffs');
    });

    it('update() still increments version without touching metadata', () => {
      const id = makeMemoryId();
      memRepo.insert({
        id,
        scope: 'profile',
        scopeId: 'p',
        path: '/y.md',
        content: 'v1',
        rationale: null,
        kind: 'gotcha',
        tags: ['a'],
        appliesWhen: null,
        avoidWhen: null,
        confidence: 0.5,
        sourceEvidence: [],
        impactSummary: null,
        approved: true,
        createdByPodId: null,
      });

      memRepo.update(id, 'v2');

      const after = memRepo.getOrThrow(id);
      expect(after.version).toBe(2);
      expect(after.content).toBe('v2');
      // metadata untouched
      expect(after.kind).toBe('gotcha');
      expect(after.tags).toEqual(['a']);
    });
  });

  describe('list and search', () => {
    it('list returns approved-only when flag is set', () => {
      const id1 = makeMemoryId();
      const id2 = makeMemoryId();
      memRepo.insert({
        id: id1,
        scope: 'profile',
        scopeId: 'p',
        path: '/a.md',
        content: 'a',
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
      memRepo.insert({
        id: id2,
        scope: 'profile',
        scopeId: 'p',
        path: '/b.md',
        content: 'b',
        rationale: null,
        kind: null,
        tags: [],
        appliesWhen: null,
        avoidWhen: null,
        confidence: null,
        sourceEvidence: [],
        impactSummary: null,
        approved: false,
        createdByPodId: null,
      });

      const approved = memRepo.list('profile', 'p', true);
      expect(approved).toHaveLength(1);
      expect(approved[0]?.id).toBe(id1);

      const all = memRepo.list('profile', 'p', false);
      expect(all).toHaveLength(2);
    });

    it('search matches path and content keywords', () => {
      const id1 = makeMemoryId();
      const id2 = makeMemoryId();
      memRepo.insert({
        id: id1,
        scope: 'profile',
        scopeId: 'p',
        path: '/migrations/guide.md',
        content: 'always run migrations',
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
      memRepo.insert({
        id: id2,
        scope: 'profile',
        scopeId: 'p',
        path: '/style.md',
        content: 'use 2-space indent',
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

      const results = memRepo.search('migration', 'profile', 'p');
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(id1);
    });
  });
});

describe('MemoryCandidateRepository', () => {
  let db: ReturnType<typeof createTestDb>;
  let memRepo: ReturnType<typeof createMemoryRepository>;
  let candRepo: ReturnType<typeof createMemoryCandidateRepository>;

  beforeEach(() => {
    db = createTestDb();
    memRepo = createMemoryRepository(db);
    candRepo = createMemoryCandidateRepository(db);
  });

  function makeCreateCandidate(overrides: Partial<Parameters<typeof candRepo.insert>[0]> = {}) {
    return {
      id: randomUUID(),
      action: 'create' as const,
      targetMemoryId: null,
      scope: 'profile' as const,
      scopeId: 'test-profile',
      path: '/gotchas/example.md',
      content: 'Do not forget to run migrations',
      rationale: 'Caught missing migration twice',
      kind: 'gotcha' as const,
      tags: ['migrations'],
      appliesWhen: 'before deploying',
      avoidWhen: null,
      confidence: 0.85,
      sourceEvidence: [
        {
          podId: 'pod-src',
          signal: 'validation_failure',
          excerpt: 'migration failed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      impactSummary: 'Saves 15 min per deployment',
      createdByPodId: 'pod-src',
      fallbackReason: null,
      ...overrides,
    };
  }

  describe('insert and get', () => {
    it('inserts a candidate and reads it back as pending', () => {
      const cand = makeCreateCandidate();
      const inserted = candRepo.insert(cand);
      expect(inserted.status).toBe('pending');
      expect(inserted.action).toBe('create');
      expect(inserted.tags).toEqual(['migrations']);
      expect(inserted.sourceEvidence[0]?.signal).toBe('validation_failure');

      const fetched = candRepo.get(cand.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(cand.id);
    });

    it('returns null for unknown id', () => {
      expect(candRepo.get('no-such-id')).toBeNull();
    });
  });

  describe('listPending', () => {
    it('returns only pending candidates for the scope', () => {
      const c1 = makeCreateCandidate({ id: randomUUID(), scopeId: 'profile-a' });
      const c2 = makeCreateCandidate({ id: randomUUID(), scopeId: 'profile-a' });
      const c3 = makeCreateCandidate({ id: randomUUID(), scopeId: 'profile-b' });
      candRepo.insert(c1);
      candRepo.insert(c2);
      candRepo.insert(c3);

      const pending = candRepo.listPending('profile-a');
      expect(pending).toHaveLength(2);
      expect(pending.every((c) => c.scopeId === 'profile-a')).toBe(true);
    });
  });

  describe('approve — create action', () => {
    it('creates a new approved MemoryEntry and marks candidate approved', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);

      const approved = candRepo.approve(cand.id, memRepo);
      expect(approved.status).toBe('approved');

      // Verify a new memory entry was created
      const memories = memRepo.list('profile', 'test-profile', true);
      expect(memories).toHaveLength(1);
      expect(memories[0]?.path).toBe(cand.path);
      expect(memories[0]?.kind).toBe('gotcha');
      expect(memories[0]?.tags).toEqual(['migrations']);
      expect(memories[0]?.confidence).toBeCloseTo(0.85);
      expect(memories[0]?.approved).toBe(true);
      expect(memories[0]?.version).toBe(1);
    });

    it('does not create a duplicate when approved twice', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);
      candRepo.approve(cand.id, memRepo);

      // Approving an already-approved candidate must throw
      expect(() => candRepo.approve(cand.id, memRepo)).toThrow(/not pending/);

      // No duplicate memory entries
      expect(memRepo.list('profile', 'test-profile', true)).toHaveLength(1);
    });
  });

  describe('approve — update action', () => {
    it('updates the target memory and increments its version', () => {
      // Create the target memory
      const memId = makeMemoryId();
      memRepo.insert({
        id: memId,
        scope: 'profile',
        scopeId: 'test-profile',
        path: '/existing.md',
        content: 'old content',
        rationale: null,
        kind: 'convention',
        tags: ['old-tag'],
        appliesWhen: null,
        avoidWhen: null,
        confidence: 0.5,
        sourceEvidence: [],
        impactSummary: null,
        approved: true,
        createdByPodId: null,
      });

      const before = memRepo.getOrThrow(memId);
      expect(before.version).toBe(1);

      // Create an update candidate
      const cand = makeCreateCandidate({
        id: randomUUID(),
        action: 'update',
        targetMemoryId: memId,
        content: 'improved content',
        kind: 'gotcha',
        tags: ['new-tag'],
        confidence: 0.95,
      });
      candRepo.insert(cand);

      const approvedCand = candRepo.approve(cand.id, memRepo);
      expect(approvedCand.status).toBe('approved');

      // Target memory is updated — version incremented, no duplicate
      const after = memRepo.getOrThrow(memId);
      expect(after.version).toBe(2);
      expect(after.content).toBe('improved content');
      expect(after.kind).toBe('gotcha');
      expect(after.tags).toEqual(['new-tag']);
      expect(after.confidence).toBeCloseTo(0.95);

      // No new memory entry was created for the same scopeId
      const allMemories = memRepo.list('profile', 'test-profile', true);
      expect(allMemories).toHaveLength(1);
    });

    it('does not create a new entry when action is update', () => {
      const memId = makeMemoryId();
      memRepo.insert({
        id: memId,
        scope: 'profile',
        scopeId: 'test-profile',
        path: '/existing.md',
        content: 'original',
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

      const countBefore = memRepo.list('profile', 'test-profile').length;

      const cand = makeCreateCandidate({
        id: randomUUID(),
        action: 'update',
        targetMemoryId: memId,
        content: 'updated',
        kind: 'workflow',
        tags: [],
        confidence: 0.7,
      });
      candRepo.insert(cand);
      candRepo.approve(cand.id, memRepo);

      expect(memRepo.list('profile', 'test-profile').length).toBe(countBefore);
    });
  });

  describe('reject', () => {
    it('marks candidate as rejected and retains it for audit', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);

      const rejected = candRepo.reject(cand.id);
      expect(rejected.status).toBe('rejected');

      // Candidate still exists in DB
      const fetched = candRepo.get(cand.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.status).toBe('rejected');

      // No memory entry was created
      expect(memRepo.list('profile', 'test-profile')).toHaveLength(0);
    });

    it('throws when rejecting a non-pending candidate', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);
      candRepo.reject(cand.id);
      expect(() => candRepo.reject(cand.id)).toThrow(/not pending/);
    });
  });

  describe('scope round-trip', () => {
    it('reads the scope column from the database (not hardcoded)', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);

      // Mutate scope at the SQL layer; the row mapper must reflect this.
      // (Defends against a previous bug where rowToCandidate hardcoded 'profile'.)
      db.prepare("UPDATE memory_candidates SET scope = 'global' WHERE id = ?").run(cand.id);

      const fetched = candRepo.get(cand.id);
      expect(fetched?.scope).toBe('global');
    });
  });

  describe('approve atomicity', () => {
    it('rolls back candidate status when memory write fails', () => {
      const cand = makeCreateCandidate();
      candRepo.insert(cand);

      // Stub memoryRepo whose insert throws — the candidate status must NOT flip to approved.
      const failingMemRepo = {
        ...memRepo,
        insert: () => {
          throw new Error('simulated memory write failure');
        },
      };

      expect(() => candRepo.approve(cand.id, failingMemRepo)).toThrow(/simulated/);

      const fetched = candRepo.get(cand.id);
      expect(fetched?.status).toBe('pending');
      expect(memRepo.list('profile', 'test-profile')).toHaveLength(0);
    });

    it('rolls back when updateMetadata fails on an update candidate', () => {
      const memId = makeMemoryId();
      memRepo.insert({
        id: memId,
        scope: 'profile',
        scopeId: 'test-profile',
        path: '/x.md',
        content: 'v1',
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

      const cand = makeCreateCandidate({
        id: randomUUID(),
        action: 'update',
        targetMemoryId: memId,
        content: 'v2',
      });
      candRepo.insert(cand);

      const failingMemRepo = {
        ...memRepo,
        updateMetadata: () => {
          throw new Error('simulated update failure');
        },
      };

      expect(() => candRepo.approve(cand.id, failingMemRepo)).toThrow(/simulated/);

      expect(candRepo.get(cand.id)?.status).toBe('pending');
      // Target memory untouched
      expect(memRepo.getOrThrow(memId).version).toBe(1);
      expect(memRepo.getOrThrow(memId).content).toBe('v1');
    });
  });

  describe('approve — update action with missing target', () => {
    it('throws when the target memory was deleted before approval', () => {
      const memId = makeMemoryId();
      memRepo.insert({
        id: memId,
        scope: 'profile',
        scopeId: 'test-profile',
        path: '/will-be-deleted.md',
        content: 'doomed',
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

      const cand = makeCreateCandidate({
        id: randomUUID(),
        action: 'update',
        targetMemoryId: memId,
        content: 'replacement',
      });
      candRepo.insert(cand);

      // Delete the target memory before approval
      memRepo.delete(memId);

      // FK ON DELETE SET NULL nulls target_memory_id when the memory is deleted;
      // approve must refuse rather than silently converting the update into a create.
      expect(() => candRepo.approve(cand.id, memRepo)).toThrow(/no longer exists/);

      // Candidate stays pending — no silent approval against a missing target
      expect(candRepo.get(cand.id)?.status).toBe('pending');
      // No new memory entry was created by the would-be fallthrough
      expect(memRepo.list('profile', 'test-profile')).toHaveLength(0);
    });
  });

  describe('list with status filter', () => {
    it('filters by status', () => {
      const c1 = makeCreateCandidate({ id: randomUUID() });
      const c2 = makeCreateCandidate({ id: randomUUID() });
      const c3 = makeCreateCandidate({ id: randomUUID() });
      candRepo.insert(c1);
      candRepo.insert(c2);
      candRepo.insert(c3);

      candRepo.approve(c1.id, memRepo);
      candRepo.reject(c2.id);

      expect(candRepo.list('test-profile', 'pending')).toHaveLength(1);
      expect(candRepo.list('test-profile', 'approved')).toHaveLength(1);
      expect(candRepo.list('test-profile', 'rejected')).toHaveLength(1);
      expect(candRepo.list('test-profile')).toHaveLength(3);
    });
  });
});

describe('MemoryUsageRepository', () => {
  let db: ReturnType<typeof createTestDb>;
  let memRepo: ReturnType<typeof createMemoryRepository>;
  let usageRepo: ReturnType<typeof createMemoryUsageRepository>;

  beforeEach(() => {
    db = createTestDb();
    memRepo = createMemoryRepository(db);
    usageRepo = createMemoryUsageRepository(db);
  });

  function insertMemory(scopeId = 'profile-a') {
    const id = makeMemoryId();
    memRepo.insert({
      id,
      scope: 'profile',
      scopeId,
      path: '/mem.md',
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
    return id;
  }

  describe('record', () => {
    it('records a usage event and returns it with createdAt', () => {
      const memId = insertMemory();
      const event = usageRepo.record({
        id: randomUUID(),
        memoryId: memId,
        podId: 'pod-001',
        kind: 'selected',
        outcome: null,
        reason: null,
        relevanceReason: 'matches migration context',
      });

      expect(event.kind).toBe('selected');
      expect(event.relevanceReason).toBe('matches migration context');
      expect(event.createdAt).toBeTruthy();
    });

    it('records all valid kind values', () => {
      const memId = insertMemory();
      const kinds = [
        'selected',
        'injected',
        'read',
        'searched',
        'plan_reported',
        'summary_reported',
        'not_reported',
      ] as const;
      for (const kind of kinds) {
        usageRepo.record({
          id: randomUUID(),
          memoryId: memId,
          podId: 'pod-x',
          kind,
          outcome: null,
          reason: null,
          relevanceReason: null,
        });
      }
      const events = usageRepo.listByMemory(memId);
      expect(events).toHaveLength(kinds.length);
      expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining([...kinds]));
    });
  });

  describe('listByMemory', () => {
    it('returns events for the specified memory only', () => {
      const mem1 = insertMemory();
      const mem2 = insertMemory();
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem1,
        podId: 'pod-a',
        kind: 'selected',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem1,
        podId: 'pod-a',
        kind: 'injected',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem2,
        podId: 'pod-a',
        kind: 'read',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });

      expect(usageRepo.listByMemory(mem1)).toHaveLength(2);
      expect(usageRepo.listByMemory(mem2)).toHaveLength(1);
    });
  });

  describe('listByPod', () => {
    it('returns all events for a pod across memories', () => {
      const mem1 = insertMemory();
      const mem2 = insertMemory('profile-b');
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem1,
        podId: 'pod-z',
        kind: 'selected',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem2,
        podId: 'pod-z',
        kind: 'plan_reported',
        outcome: 'intended',
        reason: 'mentioned in plan',
        relevanceReason: null,
      });
      usageRepo.record({
        id: randomUUID(),
        memoryId: mem1,
        podId: 'pod-other',
        kind: 'searched',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });

      const events = usageRepo.listByPod('pod-z');
      expect(events).toHaveLength(2);
      expect(events[1]?.outcome).toBe('intended');
      expect(events[1]?.reason).toBe('mentioned in plan');
    });
  });

  describe('cascade deletion', () => {
    it('deletes usage events when the memory entry is deleted', () => {
      const memId = insertMemory();
      usageRepo.record({
        id: randomUUID(),
        memoryId: memId,
        podId: 'pod-del',
        kind: 'selected',
        outcome: null,
        reason: null,
        relevanceReason: null,
      });
      expect(usageRepo.listByMemory(memId)).toHaveLength(1);

      memRepo.delete(memId);
      expect(usageRepo.listByMemory(memId)).toHaveLength(0);
    });
  });
});

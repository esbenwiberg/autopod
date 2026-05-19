import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createFixFeedbackRepository } from './fix-feedback-repository.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';

function insertTestPod(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES (?, 'test-profile', 'test task', 'queued', 'opus', 'claude', 'test-branch', 'test-user')`,
  ).run(id);
}

describe('FixFeedbackRepository', () => {
  let db: Database.Database;
  let repo: FixFeedbackRepository;
  const podId = 'pod-aaaa';

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
    insertTestPod(db, podId);
    repo = createFixFeedbackRepository(db);
  });

  it('enqueue returns a row with a generated UUID; peek finds it; count returns 1', () => {
    const row = repo.enqueue(podId, 'Fix the lint errors');

    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(row.podId).toBe(podId);
    expect(row.message).toBe('Fix the lint errors');
    expect(typeof row.createdAt).toBe('number');

    const peeked = repo.peek(podId);
    expect(peeked).toHaveLength(1);
    expect(peeked[0]).toEqual(row);

    expect(repo.count(podId)).toBe(1);
  });

  it('two enqueues — peek returns both in append order; count = 2', () => {
    const r1 = repo.enqueue(podId, 'First message');
    const r2 = repo.enqueue(podId, 'Second message');

    const peeked = repo.peek(podId);
    expect(peeked).toHaveLength(2);
    // created_at ASC — first enqueued is first returned
    expect(peeked[0]?.id).toBe(r1.id);
    expect(peeked[1]?.id).toBe(r2.id);

    expect(repo.count(podId)).toBe(2);
  });

  it('drain returns the same rows peek does; subsequent peek returns []; count returns 0', () => {
    repo.enqueue(podId, 'msg-a');
    repo.enqueue(podId, 'msg-b');

    const beforeDrain = repo.peek(podId);
    const drained = repo.drain(podId);

    expect(drained).toHaveLength(2);
    expect(drained.map((r) => r.id)).toEqual(beforeDrain.map((r) => r.id));

    expect(repo.peek(podId)).toHaveLength(0);
    expect(repo.count(podId)).toBe(0);
  });

  it('drain on an empty queue returns [] without throwing', () => {
    expect(() => repo.drain(podId)).not.toThrow();
    expect(repo.drain(podId)).toEqual([]);
  });

  it('enqueue after drain — the new row is the only one returned by peek', () => {
    repo.enqueue(podId, 'first');
    repo.drain(podId);

    const row = repo.enqueue(podId, 'after-drain');
    const peeked = repo.peek(podId);

    expect(peeked).toHaveLength(1);
    expect(peeked[0]?.id).toBe(row.id);
    expect(peeked[0]?.message).toBe('after-drain');
  });

  it('peekLatest returns the most recently enqueued row; null when empty', () => {
    expect(repo.peekLatest(podId)).toBeNull();

    repo.enqueue(podId, 'first');
    repo.enqueue(podId, 'second');
    repo.enqueue(podId, 'third');

    expect(repo.peekLatest(podId)?.message).toBe('third');

    repo.drain(podId);
    expect(repo.peekLatest(podId)).toBeNull();
  });

  it('concurrent simulation: interleaved enqueue and drain are consistent', () => {
    const allMessages: string[] = [];
    const drainedMessages: string[] = [];

    // Enqueue batch 1
    for (let i = 0; i < 3; i++) {
      const msg = `batch1-${i}`;
      allMessages.push(msg);
      repo.enqueue(podId, msg);
    }

    // Drain batch 1
    const drain1 = repo.drain(podId);
    drainedMessages.push(...drain1.map((r) => r.message));

    // Enqueue batch 2
    for (let i = 0; i < 2; i++) {
      const msg = `batch2-${i}`;
      allMessages.push(msg);
      repo.enqueue(podId, msg);
    }

    // Drain batch 2
    const drain2 = repo.drain(podId);
    drainedMessages.push(...drain2.map((r) => r.message));

    // Every enqueued message must appear in exactly one drain
    expect(drainedMessages.sort()).toEqual(allMessages.sort());
    expect(repo.peek(podId)).toHaveLength(0);
  });
});

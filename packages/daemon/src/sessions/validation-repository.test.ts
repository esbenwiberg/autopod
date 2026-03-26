import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createValidationRepository } from './validation-repository.js';

function setupDb() {
  const db = createTestDb();
  insertTestProfile(db);
  return db;
}

function makeResult(sessionId: string, attempt: number) {
  return {
    sessionId,
    attempt,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'pass' as const,
      build: { status: 'pass' as const, output: '', duration: 100 },
      health: {
        status: 'pass' as const,
        url: 'http://localhost:3000',
        responseCode: 200,
        duration: 50,
      },
      pages: [
        {
          path: '/',
          status: 'pass' as const,
          screenshotPath: '/screenshots/root.png',
          screenshotBase64: 'iVBORw0KGgoAAAANSUhEUg==',
          consoleErrors: [],
          assertions: [],
          loadTime: 200,
        },
      ],
    },
    taskReview: null,
    overall: 'pass' as const,
    duration: 5000,
  };
}

describe('ValidationRepository', () => {
  it('should insert and retrieve validation attempts', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO sessions (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-1', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const repo = createValidationRepository(db);

    const result1 = makeResult('sess-1', 1);
    const result2 = makeResult('sess-1', 2);

    repo.insert('sess-1', 1, result1);
    repo.insert('sess-1', 2, result2);

    const history = repo.getForSession('sess-1');
    expect(history).toHaveLength(2);
    expect(history[0]?.attempt).toBe(1);
    expect(history[1]?.attempt).toBe(2);
    expect(history[0]?.result.overall).toBe('pass');
    expect(history[0]?.screenshots).toHaveLength(1);
    expect(history[0]?.screenshots[0]).toBe('iVBORw0KGgoAAAANSUhEUg==');
  });

  it('should return empty array for session with no validations', () => {
    const db = setupDb();
    const repo = createValidationRepository(db);
    expect(repo.getForSession('nonexistent')).toEqual([]);
  });

  it('should preserve full ValidationResult through JSON roundtrip', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO sessions (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-2', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const repo = createValidationRepository(db);
    const result = makeResult('sess-2', 1);
    result.smoke.status = 'fail';
    result.overall = 'fail';

    repo.insert('sess-2', 1, result);

    const [stored] = repo.getForSession('sess-2');
    expect(stored?.result.smoke.status).toBe('fail');
    expect(stored?.result.overall).toBe('fail');
    expect(stored?.result.smoke.pages[0]?.screenshotPath).toBe('/screenshots/root.png');
  });
});

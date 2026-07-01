import type { ScreenshotRef, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createValidationRepository } from './validation-repository.js';

function setupDb() {
  const db = createTestDb();
  insertTestProfile(db);
  return db;
}

const SMOKE_REF: ScreenshotRef = {
  podId: 'sess-1',
  source: 'smoke',
  filename: '0-root.png',
  relativePath: 'screenshots/sess-1/smoke/0-root.png',
};

function makeResult(podId: string, attempt: number): ValidationResult {
  return {
    podId,
    attempt,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: {
        status: 'pass',
        url: 'http://localhost:3000',
        responseCode: 200,
        duration: 50,
      },
      pages: [
        {
          path: '/',
          status: 'pass',
          screenshotPath: '/screenshots/root.png',
          screenshot: SMOKE_REF,
          consoleErrors: [],
          assertions: [],
          loadTime: 200,
        },
      ],
    },
    taskReview: null,
    overall: 'pass',
    duration: 5000,
  };
}

describe('ValidationRepository', () => {
  it('should insert and retrieve validation attempts', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-1', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const repo = createValidationRepository(db);

    const result1 = makeResult('sess-1', 1);
    const result2 = makeResult('sess-1', 2);

    repo.insert('sess-1', 1, result1, 0);
    repo.insert('sess-1', 2, result2, 0);

    const history = repo.getForSession('sess-1');
    expect(history).toHaveLength(2);
    expect(history[0]?.attempt).toBe(1);
    expect(history[1]?.attempt).toBe(2);
    expect(history[0]?.result.overall).toBe('pass');
  });

  it('should return empty array for pod with no validations', () => {
    const db = setupDb();
    const repo = createValidationRepository(db);
    expect(repo.getForSession('nonexistent')).toEqual([]);
  });

  it('should preserve full ValidationResult through JSON roundtrip', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-2', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const repo = createValidationRepository(db);
    const result = makeResult('sess-2', 1);
    result.smoke.status = 'fail';
    result.overall = 'fail';

    repo.insert('sess-2', 1, result, 0);

    const [stored] = repo.getForSession('sess-2');
    expect(stored?.result.smoke.status).toBe('fail');
    expect(stored?.result.overall).toBe('fail');
    expect(stored?.result.smoke.pages[0]?.screenshotPath).toBe('/screenshots/root.png');
  });

  it('updates only the requested pod and attempt result', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-2', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-other', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const repo = createValidationRepository(db);
    repo.insert('sess-2', 1, makeResult('sess-2', 1), 0);
    repo.insert('sess-2', 2, makeResult('sess-2', 2), 0);
    repo.insert('sess-other', 1, makeResult('sess-other', 1), 0);

    const advisoryRef: ScreenshotRef = {
      podId: 'sess-2',
      source: 'advisory',
      filename: 'advisory-0.png',
      relativePath: 'screenshots/sess-2/advisory/advisory-0.png',
    };
    const updated = makeResult('sess-2', 2);
    updated.advisoryBrowserQa = {
      status: 'fail',
      reasoning: 'Advisory issue only.',
      observations: [
        {
          id: 'obs-1',
          scenarioId: 'scenario-1',
          status: 'fail',
          summary: 'Layout overflowed.',
          details: 'The submit button is clipped.',
          screenshots: [advisoryRef],
        },
      ],
      screenshots: [advisoryRef],
      durationMs: 1234,
    };

    expect(repo.updateResult('sess-2', 2, updated, 0)).toBe(true);
    expect(repo.updateResult('sess-missing', 2, updated, 0)).toBe(false);

    const history = repo.getForSession('sess-2');
    expect(history).toHaveLength(2);
    expect(history[0]?.result.advisoryBrowserQa).toBeUndefined();
    expect(history[1]?.result.advisoryBrowserQa?.reasoning).toBe('Advisory issue only.');
    expect(history[1]?.result.advisoryBrowserQa?.screenshots[0]?.source).toBe('advisory');

    const otherHistory = repo.getForSession('sess-other');
    expect(otherHistory).toHaveLength(1);
    expect(otherHistory[0]?.result.advisoryBrowserQa).toBeUndefined();
  });

  it('round-trips ScreenshotRef fields through JSON serialisation', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-3', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const reviewRef: ScreenshotRef = {
      podId: 'sess-3',
      source: 'review',
      filename: '1-0.png',
      relativePath: 'screenshots/sess-3/review/1-0.png',
    };

    const result: ValidationResult = {
      podId: 'sess-3',
      attempt: 1,
      timestamp: new Date().toISOString(),
      smoke: {
        status: 'pass',
        build: { status: 'pass', output: '', duration: 100 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 50 },
        pages: [
          {
            path: '/',
            status: 'pass',
            screenshotPath: '/ss.png',
            screenshot: {
              podId: 'sess-3',
              source: 'smoke',
              filename: '0-root.png',
              relativePath: 'screenshots/sess-3/smoke/0-root.png',
            },
            consoleErrors: [],
            assertions: [],
            loadTime: 100,
          },
        ],
      },
      taskReview: {
        status: 'pass',
        reasoning: 'looks good',
        issues: [],
        model: 'sonnet',
        screenshots: [reviewRef],
        diff: 'diff',
      },
      overall: 'pass',
      duration: 1000,
    };

    const repo = createValidationRepository(db);
    repo.insert('sess-3', 1, result, 0);

    const [stored] = repo.getForSession('sess-3');
    // ScreenshotRef on smoke page survived roundtrip
    expect(stored?.result.smoke.pages[0]?.screenshot?.source).toBe('smoke');
    expect(stored?.result.smoke.pages[0]?.screenshot?.filename).toBe('0-root.png');
    // ScreenshotRef on review survived roundtrip
    expect(stored?.result.taskReview?.screenshots[0]?.source).toBe('review');
    expect(stored?.result.taskReview?.screenshots[0]?.filename).toBe('1-0.png');
    // No base64 strings anywhere
    const raw = JSON.stringify(stored?.result);
    expect(raw).not.toContain('screenshotBase64');
    expect(raw.match(/[A-Za-z0-9+/]{50,}/)).toBeNull(); // no long base64 blobs
  });

  it('scopes rows by rework and keeps attempts distinct across reworks', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-rw', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    const repo = createValidationRepository(db);

    // Rework 0 failed across three attempts; rework 1 passed on its first attempt.
    const fail = (attempt: number) => {
      const r = makeResult('sess-rw', attempt);
      r.smoke.status = 'fail';
      r.overall = 'fail';
      return r;
    };
    repo.insert('sess-rw', 1, fail(1), 0);
    repo.insert('sess-rw', 2, fail(2), 0);
    repo.insert('sess-rw', 3, fail(3), 0);
    repo.insert('sess-rw', 1, makeResult('sess-rw', 1), 1);

    const history = repo.getForSession('sess-rw');
    expect(history).toHaveLength(4);
    // Ordered by (rework, attempt): rework 0's three attempts, then rework 1's attempt 1.
    expect(history.map((v) => [v.reworkCount, v.attempt])).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 1],
    ]);
    expect(history[3]?.result.overall).toBe('pass');
  });

  it('updateResult targets the row for a specific rework, not just the attempt number', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-rw2', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    const repo = createValidationRepository(db);

    repo.insert('sess-rw2', 1, makeResult('sess-rw2', 1), 0);
    repo.insert('sess-rw2', 1, makeResult('sess-rw2', 1), 1);

    const updated = makeResult('sess-rw2', 1);
    updated.overall = 'fail';
    // Updating rework 1's attempt 1 must not touch rework 0's identically-numbered row.
    expect(repo.updateResult('sess-rw2', 1, updated, 1)).toBe(true);

    const history = repo.getForSession('sess-rw2');
    const rework0 = history.find((v) => v.reworkCount === 0);
    const rework1 = history.find((v) => v.reworkCount === 1);
    expect(rework0?.result.overall).toBe('pass');
    expect(rework1?.result.overall).toBe('fail');
  });

  it('does not reference the screenshots column', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-4', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    const repo = createValidationRepository(db);
    // Should not throw even though the screenshots column was dropped by migration 091
    expect(() => repo.insert('sess-4', 1, makeResult('sess-4', 1), 0)).not.toThrow();
    const [v] = repo.getForSession('sess-4');
    // StoredValidation no longer has a screenshots field
    expect((v as Record<string, unknown>).screenshots).toBeUndefined();
  });
});

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

    repo.insert('sess-1', 1, result1);
    repo.insert('sess-1', 2, result2);

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

    repo.insert('sess-2', 1, result);

    const [stored] = repo.getForSession('sess-2');
    expect(stored?.result.smoke.status).toBe('fail');
    expect(stored?.result.overall).toBe('fail');
    expect(stored?.result.smoke.pages[0]?.screenshotPath).toBe('/screenshots/root.png');
  });

  it('round-trips ScreenshotRef fields through JSON serialisation', () => {
    const db = setupDb();

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-3', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();

    const acRef: ScreenshotRef = {
      podId: 'sess-3',
      source: 'ac',
      filename: '1-0.png',
      relativePath: 'screenshots/sess-3/ac/1-0.png',
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
      acValidation: {
        status: 'pass',
        results: [{ criterion: 'test', passed: true, reasoning: 'ok', screenshot: acRef }],
        model: 'sonnet',
      },
      taskReview: {
        status: 'pass',
        reasoning: 'looks good',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: 'diff',
      },
      overall: 'pass',
      duration: 1000,
    };

    const repo = createValidationRepository(db);
    repo.insert('sess-3', 1, result);

    const [stored] = repo.getForSession('sess-3');
    // ScreenshotRef on smoke page survived roundtrip
    expect(stored?.result.smoke.pages[0]?.screenshot?.source).toBe('smoke');
    expect(stored?.result.smoke.pages[0]?.screenshot?.filename).toBe('0-root.png');
    // ScreenshotRef on AC check survived roundtrip
    const checks = stored?.result.acValidation?.results;
    expect(checks?.[0]?.screenshot?.source).toBe('ac');
    expect(checks?.[0]?.screenshot?.filename).toBe('1-0.png');
    // No base64 strings anywhere
    const raw = JSON.stringify(stored?.result);
    expect(raw).not.toContain('screenshotBase64');
    expect(raw.match(/[A-Za-z0-9+/]{50,}/)).toBeNull(); // no long base64 blobs
  });

  it('does not reference the screenshots column', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('sess-4', 'test-profile', 'test task', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    const repo = createValidationRepository(db);
    // Should not throw even though the screenshots column was dropped by migration 091
    expect(() => repo.insert('sess-4', 1, makeResult('sess-4', 1))).not.toThrow();
    const [v] = repo.getForSession('sess-4');
    // StoredValidation no longer has a screenshots field
    expect((v as Record<string, unknown>).screenshots).toBeUndefined();
  });
});

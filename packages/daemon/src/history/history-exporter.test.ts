import type { AgentActivityEvent, PodStatus, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { createEscalationRepository } from '../pods/escalation-repository.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createProgressEventRepository } from '../pods/progress-event-repository.js';
import { createValidationRepository } from '../pods/validation-repository.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createHistoryExporter } from './history-exporter.js';

function seedSession(
  db: Database.Database,
  overrides: {
    id?: string;
    profileName?: string;
    status?: PodStatus;
    task?: string;
    costUsd?: number;
    validationAttempts?: number;
  } = {},
) {
  const id = overrides.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id,
      max_validation_attempts, skip_validation, output_mode, validation_attempts, cost_usd,
      input_tokens, output_tokens, files_changed, lines_added, lines_removed, escalation_count, commit_count)
    VALUES (@id, @profileName, @task, @status, 'opus', 'claude', @branch, 'user1',
      3, 0, 'pr', @validationAttempts, @costUsd, 1000, 500, 3, 10, 5, 0, 2)
  `).run({
    id,
    profileName: overrides.profileName ?? 'test-profile',
    task: overrides.task ?? 'Test task',
    status: overrides.status ?? 'complete',
    branch: `autopod/${id}`,
    validationAttempts: overrides.validationAttempts ?? 1,
    costUsd: overrides.costUsd ?? 0.5,
  });
  return id;
}

function makeValidationResult(overall: 'pass' | 'fail'): ValidationResult {
  return {
    podId: '',
    attempt: 1,
    timestamp: new Date().toISOString(),
    smoke: {
      status: overall,
      build: {
        status: overall,
        output: overall === 'fail' ? 'Error: build failed' : 'OK',
        duration: 1000,
      },
      health: {
        status: 'pass',
        url: 'http://localhost:3000/health',
        responseCode: 200,
        duration: 500,
      },
      pages: [
        {
          path: '/',
          status: 'pass',
          screenshotPath: '/tmp/screenshot.png',
          screenshotBase64: 'base64data',
          consoleErrors: [],
          assertions: [],
          loadTime: 200,
        },
      ],
    },
    taskReview:
      overall === 'fail'
        ? {
            status: 'fail',
            reasoning: 'Tests are not passing',
            issues: ['Missing error handling', 'No input validation'],
            model: 'opus',
            screenshots: [],
            diff: '',
          }
        : null,
    overall,
    duration: 5000,
  };
}

describe('history-exporter', () => {
  it('exports pods to a valid SQLite database', () => {
    const db = createTestDb();
    insertTestProfile(db);

    const podRepo = createPodRepository(db);
    const validationRepo = createValidationRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventRepo = createEventRepository(db);
    const progressEventRepo = createProgressEventRepository(db);

    // Seed data
    const id1 = seedSession(db, { status: 'complete', costUsd: 1.5 });
    const id2 = seedSession(db, { status: 'failed', costUsd: 2.0, validationAttempts: 3 });
    seedSession(db, { status: 'complete', costUsd: 0.3 });

    // Add a validation for pod 2
    validationRepo.insert(id2, 1, makeValidationResult('fail'));

    // Add an escalation for pod 2
    db.prepare(`
      INSERT INTO escalations (id, pod_id, type, payload)
      VALUES ('esc1', @podId, 'ask_human', @payload)
    `).run({
      podId: id2,
      payload: JSON.stringify({ question: 'How do I configure the database?' }),
    });

    // Add an error event for pod 1
    const errorEvent: AgentActivityEvent = {
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId: id1,
      event: {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Connection timeout',
        fatal: false,
      },
    };
    eventRepo.insert(errorEvent);

    // Add progress event
    progressEventRepo.insert(id1, 'analyzing', 'Analyzing codebase', 1, 3);

    const exporter = createHistoryExporter({
      podRepo,
      validationRepo,
      escalationRepo,
      eventRepo,
      progressEventRepo,
    });

    const result = exporter.export({});

    // Verify the DB buffer is valid SQLite
    const historyDb = new Database(result.dbBuffer);

    // Check pods table
    const pods = historyDb.prepare('SELECT * FROM pods').all() as Record<string, unknown>[];
    expect(pods).toHaveLength(3);

    // Check validations table
    const validations = historyDb.prepare('SELECT * FROM validations').all() as Record<
      string,
      unknown
    >[];
    expect(validations).toHaveLength(1);
    expect(validations[0].overall).toBe('fail');
    expect(validations[0].failed_phases).toContain('build');

    // Check escalations table
    const escalations = historyDb.prepare('SELECT * FROM escalations').all() as Record<
      string,
      unknown
    >[];
    expect(escalations).toHaveLength(1);
    expect(escalations[0].type).toBe('ask_human');
    expect(escalations[0].question).toContain('database');

    // Check errors table
    const errors = historyDb.prepare('SELECT * FROM errors').all() as Record<string, unknown>[];
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Connection timeout');

    // Check progress_events table
    const progress = historyDb.prepare('SELECT * FROM progress_events').all() as Record<
      string,
      unknown
    >[];
    expect(progress).toHaveLength(1);
    expect(progress[0].phase).toBe('analyzing');

    historyDb.close();

    // Verify stats
    expect(result.stats.totalSessions).toBe(3);
    expect(result.stats.totalCost).toBeCloseTo(3.8, 1);

    // Verify summary contains expected text
    expect(result.summary).toContain('Total pods');
    expect(result.summary).toContain('test-profile');

    // Verify analysis guide
    expect(result.analysisGuide).toContain('pods');
    expect(result.analysisGuide).toContain('validations');
    expect(result.analysisGuide).toContain('escalations');
    expect(result.analysisGuide).toContain('SELECT');
  });

  it('respects failuresOnly filter', () => {
    const db = createTestDb();
    insertTestProfile(db);

    const podRepo = createPodRepository(db);
    const validationRepo = createValidationRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventRepo = createEventRepository(db);
    const progressEventRepo = createProgressEventRepository(db);

    seedSession(db, { status: 'complete' });
    seedSession(db, { status: 'failed' });
    seedSession(db, { status: 'killed' });

    const exporter = createHistoryExporter({
      podRepo,
      validationRepo,
      escalationRepo,
      eventRepo,
      progressEventRepo,
    });

    const result = exporter.export({ failuresOnly: true });
    expect(result.stats.totalSessions).toBe(2);
  });

  it('respects limit filter', () => {
    const db = createTestDb();
    insertTestProfile(db);

    const podRepo = createPodRepository(db);
    const validationRepo = createValidationRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventRepo = createEventRepository(db);
    const progressEventRepo = createProgressEventRepository(db);

    for (let i = 0; i < 10; i++) {
      seedSession(db, { status: 'complete' });
    }

    const exporter = createHistoryExporter({
      podRepo,
      validationRepo,
      escalationRepo,
      eventRepo,
      progressEventRepo,
    });

    const result = exporter.export({ limit: 3 });
    expect(result.stats.totalSessions).toBe(3);
  });

  it('strips screenshots from exported validations', () => {
    const db = createTestDb();
    insertTestProfile(db);

    const podRepo = createPodRepository(db);
    const validationRepo = createValidationRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventRepo = createEventRepository(db);
    const progressEventRepo = createProgressEventRepository(db);

    const id = seedSession(db, { status: 'validated' });
    validationRepo.insert(id, 1, makeValidationResult('pass'));

    const exporter = createHistoryExporter({
      podRepo,
      validationRepo,
      escalationRepo,
      eventRepo,
      progressEventRepo,
    });

    const result = exporter.export({});
    const historyDb = new Database(result.dbBuffer);

    // The exported validations table should not have screenshotBase64
    const columns = historyDb.prepare("PRAGMA table_info('validations')").all() as {
      name: string;
    }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).not.toContain('screenshot');
    expect(columnNames).not.toContain('screenshots');

    historyDb.close();
  });
});

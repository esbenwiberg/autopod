import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import type { EscalationRequest, EscalationResponse } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import {
  createEscalationRepository,
  type EscalationRepository,
} from './escalation-repository.js';

const MIGRATION_SQL = fs.readFileSync(
  path.resolve(import.meta.dirname, '../db/migrations/001_initial.sql'),
  'utf-8',
);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  return db;
}

function seedSessionWithProfile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES ('test-app', 'https://github.com/org/repo', 'npm build', 'node app.js')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES ('sess-001', 'test-app', 'test task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
  ).run();
}

const validEscalation: EscalationRequest = {
  id: 'esc-001',
  sessionId: 'sess-001',
  type: 'ask_human',
  timestamp: '2026-01-01T00:00:00.000Z',
  payload: {
    question: 'What color should the button be?',
    context: 'Working on the UI redesign',
    options: ['blue', 'green', 'red'],
  },
  response: null,
};

const validResponse: EscalationResponse = {
  respondedAt: '2026-01-01T01:00:00.000Z',
  respondedBy: 'human',
  response: 'Make it blue',
};

describe('EscalationRepository', () => {
  let db: Database.Database;
  let repo: EscalationRepository;

  beforeEach(() => {
    db = createTestDb();
    seedSessionWithProfile(db);
    repo = createEscalationRepository(db);
  });

  describe('insert', () => {
    it('should insert an escalation and read it back', () => {
      repo.insert(validEscalation);
      const row = repo.getOrThrow('esc-001');
      expect(row.id).toBe('esc-001');
      expect(row.sessionId).toBe('sess-001');
      expect(row.type).toBe('ask_human');
      expect(row.payload).toEqual(validEscalation.payload);
      expect(row.response).toBeNull();
      expect(row.resolvedAt).toBeNull();
    });

    it('should throw on duplicate id', () => {
      repo.insert(validEscalation);
      expect(() => repo.insert(validEscalation)).toThrow();
    });

    it('should throw on FK violation for nonexistent session', () => {
      expect(() =>
        repo.insert({ ...validEscalation, id: 'esc-bad', sessionId: 'nonexistent' }),
      ).toThrow();
    });

    it('should store complex payload as JSON', () => {
      const blockerEscalation: EscalationRequest = {
        id: 'esc-002',
        sessionId: 'sess-001',
        type: 'report_blocker',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          description: 'Cannot access database',
          attempted: ['restart', 'reconnect'],
          needs: 'DBA access',
        },
        response: null,
      };
      repo.insert(blockerEscalation);
      const row = repo.getOrThrow('esc-002');
      expect(row.payload).toEqual(blockerEscalation.payload);
    });
  });

  describe('getOrThrow', () => {
    it('should throw for nonexistent escalation', () => {
      expect(() => repo.getOrThrow('nope')).toThrow(AutopodError);
      expect(() => repo.getOrThrow('nope')).toThrow('not found');
    });
  });

  describe('update', () => {
    it('should update escalation with a response', () => {
      repo.insert(validEscalation);
      repo.update('esc-001', validResponse);

      const row = repo.getOrThrow('esc-001');
      expect(row.response).toEqual(validResponse);
      expect(row.resolvedAt).not.toBeNull();
    });

    it('should throw for nonexistent escalation', () => {
      expect(() => repo.update('nope', validResponse)).toThrow(AutopodError);
      expect(() => repo.update('nope', validResponse)).toThrow('not found');
    });

    it('should store AI response with model field', () => {
      repo.insert(validEscalation);
      const aiResponse: EscalationResponse = {
        respondedAt: '2026-01-01T01:00:00.000Z',
        respondedBy: 'ai',
        response: 'Based on design guidelines, use blue (#0066cc)',
        model: 'sonnet',
      };
      repo.update('esc-001', aiResponse);

      const row = repo.getOrThrow('esc-001');
      expect(row.response?.respondedBy).toBe('ai');
      expect(row.response?.model).toBe('sonnet');
    });
  });

  describe('countBySessionAndType', () => {
    it('should count escalations for a session and type', () => {
      repo.insert(validEscalation);
      repo.insert({ ...validEscalation, id: 'esc-002' });
      repo.insert({ ...validEscalation, id: 'esc-003', type: 'ask_ai' });

      expect(repo.countBySessionAndType('sess-001', 'ask_human')).toBe(2);
      expect(repo.countBySessionAndType('sess-001', 'ask_ai')).toBe(1);
      expect(repo.countBySessionAndType('sess-001', 'report_blocker')).toBe(0);
    });

    it('should return 0 for nonexistent session', () => {
      expect(repo.countBySessionAndType('nonexistent', 'ask_human')).toBe(0);
    });
  });
});

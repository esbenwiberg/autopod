import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { SessionNotFoundError } from '@autopod/shared';
import {
  createSessionRepository,
  type SessionRepository,
  type NewSession,
} from './session-repository.js';

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

function seedProfile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES ('test-app', 'https://github.com/org/repo', 'npm build', 'node app.js --port $PORT')`,
  ).run();
}

const validSession: NewSession = {
  id: 'sess-001',
  profileName: 'test-app',
  task: 'Add a dark mode toggle',
  status: 'queued',
  model: 'opus',
  runtime: 'claude',
  branch: 'feature/dark-mode',
  userId: 'user-1',
  maxValidationAttempts: 3,
  skipValidation: false,
};

describe('SessionRepository', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = createTestDb();
    seedProfile(db);
    repo = createSessionRepository(db);
  });

  describe('insert', () => {
    it('should insert a session and read it back', () => {
      repo.insert(validSession);
      const session = repo.getOrThrow('sess-001');
      expect(session.id).toBe('sess-001');
      expect(session.profileName).toBe('test-app');
      expect(session.task).toBe('Add a dark mode toggle');
      expect(session.status).toBe('queued');
      expect(session.model).toBe('opus');
      expect(session.runtime).toBe('claude');
      expect(session.branch).toBe('feature/dark-mode');
      expect(session.userId).toBe('user-1');
      expect(session.maxValidationAttempts).toBe(3);
      expect(session.skipValidation).toBe(false);
    });

    it('should set defaults for optional DB columns', () => {
      repo.insert(validSession);
      const session = repo.getOrThrow('sess-001');
      expect(session.containerId).toBeNull();
      expect(session.worktreePath).toBeNull();
      expect(session.validationAttempts).toBe(0);
      expect(session.lastValidationResult).toBeNull();
      expect(session.pendingEscalation).toBeNull();
      expect(session.escalationCount).toBe(0);
      expect(session.startedAt).toBeNull();
      expect(session.completedAt).toBeNull();
      expect(session.filesChanged).toBe(0);
      expect(session.linesAdded).toBe(0);
      expect(session.linesRemoved).toBe(0);
      expect(session.previewUrl).toBeNull();
    });

    it('should store skipValidation=true as 1 and read back as true', () => {
      repo.insert({ ...validSession, id: 'sess-skip', skipValidation: true });
      const session = repo.getOrThrow('sess-skip');
      expect(session.skipValidation).toBe(true);
    });

    it('should throw on duplicate id', () => {
      repo.insert(validSession);
      expect(() => repo.insert(validSession)).toThrow();
    });

    it('should throw on FK violation for nonexistent profile', () => {
      expect(() =>
        repo.insert({ ...validSession, id: 'sess-bad', profileName: 'nonexistent' }),
      ).toThrow();
    });
  });

  describe('getOrThrow', () => {
    it('should throw SessionNotFoundError for nonexistent id', () => {
      expect(() => repo.getOrThrow('nope')).toThrow(SessionNotFoundError);
    });
  });

  describe('update', () => {
    it('should update status', () => {
      repo.insert(validSession);
      repo.update('sess-001', { status: 'running' });
      const session = repo.getOrThrow('sess-001');
      expect(session.status).toBe('running');
    });

    it('should update multiple fields at once', () => {
      repo.insert(validSession);
      repo.update('sess-001', {
        status: 'running',
        containerId: 'ctr-abc',
        worktreePath: '/tmp/wt/sess-001',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const session = repo.getOrThrow('sess-001');
      expect(session.status).toBe('running');
      expect(session.containerId).toBe('ctr-abc');
      expect(session.worktreePath).toBe('/tmp/wt/sess-001');
      expect(session.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should update updatedAt timestamp', () => {
      repo.insert(validSession);
      const before = repo.getOrThrow('sess-001').updatedAt;
      // Force a known old timestamp
      db.prepare("UPDATE sessions SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'sess-001'").run();
      repo.update('sess-001', { status: 'running' });
      const after = repo.getOrThrow('sess-001').updatedAt;
      expect(after).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('should set containerId to null', () => {
      repo.insert(validSession);
      repo.update('sess-001', { containerId: 'ctr-abc' });
      expect(repo.getOrThrow('sess-001').containerId).toBe('ctr-abc');
      repo.update('sess-001', { containerId: null });
      expect(repo.getOrThrow('sess-001').containerId).toBeNull();
    });

    it('should store and retrieve lastValidationResult as JSON', () => {
      repo.insert(validSession);
      const result = { overall: 'pass', attempt: 1 };
      repo.update('sess-001', { lastValidationResult: result });
      const session = repo.getOrThrow('sess-001');
      expect(session.lastValidationResult).toEqual(result);
    });

    it('should clear lastValidationResult with null', () => {
      repo.insert(validSession);
      repo.update('sess-001', { lastValidationResult: { overall: 'pass' } });
      repo.update('sess-001', { lastValidationResult: null });
      expect(repo.getOrThrow('sess-001').lastValidationResult).toBeNull();
    });

    it('should store and retrieve pendingEscalation as JSON', () => {
      repo.insert(validSession);
      const escalation = { id: 'esc-1', type: 'ask_human', question: 'help?' };
      repo.update('sess-001', { pendingEscalation: escalation });
      const session = repo.getOrThrow('sess-001');
      expect(session.pendingEscalation).toEqual(escalation);
    });

    it('should be a no-op for empty changes', () => {
      repo.insert(validSession);
      repo.update('sess-001', {});
      // Should not throw, session unchanged
      const session = repo.getOrThrow('sess-001');
      expect(session.status).toBe('queued');
    });

    it('should throw SessionNotFoundError for nonexistent id', () => {
      expect(() => repo.update('nope', { status: 'running' })).toThrow(SessionNotFoundError);
    });

    it('should update diff stats', () => {
      repo.insert(validSession);
      repo.update('sess-001', { filesChanged: 5, linesAdded: 120, linesRemoved: 30 });
      const session = repo.getOrThrow('sess-001');
      expect(session.filesChanged).toBe(5);
      expect(session.linesAdded).toBe(120);
      expect(session.linesRemoved).toBe(30);
    });

    it('should update previewUrl', () => {
      repo.insert(validSession);
      repo.update('sess-001', { previewUrl: 'http://localhost:3000' });
      expect(repo.getOrThrow('sess-001').previewUrl).toBe('http://localhost:3000');
    });
  });

  describe('list', () => {
    it('should return all sessions ordered by created_at DESC', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', task: 'Second task' });
      // Force different timestamps so ordering is deterministic
      db.prepare("UPDATE sessions SET created_at = '2026-01-01T00:00:00' WHERE id = 'sess-001'").run();
      db.prepare("UPDATE sessions SET created_at = '2026-01-02T00:00:00' WHERE id = 'sess-002'").run();

      const sessions = repo.list();
      expect(sessions).toHaveLength(2);
      // Most recent first
      expect(sessions[0].id).toBe('sess-002');
      expect(sessions[1].id).toBe('sess-001');
    });

    it('should return empty array when no sessions', () => {
      expect(repo.list()).toEqual([]);
    });

    it('should filter by profileName', () => {
      db.prepare(
        `INSERT INTO profiles (name, repo_url, build_command, start_command)
         VALUES ('other-app', 'https://github.com/org/other', 'npm build', 'node other.js')`,
      ).run();
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', profileName: 'other-app' });

      const filtered = repo.list({ profileName: 'test-app' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].profileName).toBe('test-app');
    });

    it('should filter by status', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', status: 'running' as const });
      const filtered = repo.list({ status: 'queued' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe('queued');
    });

    it('should filter by userId', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', userId: 'user-2' });
      const filtered = repo.list({ userId: 'user-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].userId).toBe('user-1');
    });

    it('should combine multiple filters', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', status: 'running' as const });
      repo.insert({ ...validSession, id: 'sess-003', userId: 'user-2' });

      const filtered = repo.list({ status: 'queued', userId: 'user-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('sess-001');
    });
  });

  describe('countByStatusAndProfile', () => {
    it('should count matching sessions', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002' });
      repo.insert({ ...validSession, id: 'sess-003', status: 'running' as const });

      expect(repo.countByStatusAndProfile('queued', 'test-app')).toBe(2);
      expect(repo.countByStatusAndProfile('running', 'test-app')).toBe(1);
      expect(repo.countByStatusAndProfile('complete', 'test-app')).toBe(0);
    });

    it('should return 0 for nonexistent profile', () => {
      expect(repo.countByStatusAndProfile('queued', 'nonexistent')).toBe(0);
    });
  });
});

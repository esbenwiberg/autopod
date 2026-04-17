import fs from 'node:fs';
import path from 'node:path';
import { PodNotFoundError } from '@autopod/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type NewPod,
  type PodRepository,
  createPodRepository,
} from './pod-repository.js';

const migrationsDir = path.resolve(import.meta.dirname, '../db/migrations');
const MIGRATION_FILES = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATION_FILES) {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        db.exec(`${stmt};`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
  }
  return db;
}

function seedProfile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES ('test-app', 'https://github.com/org/repo', 'npm build', 'node app.js --port $PORT')`,
  ).run();
}

const validSession: NewPod = {
  id: 'sess-001',
  profileName: 'test-app',
  task: 'Add a dark mode toggle',
  status: 'queued',
  model: 'opus',
  runtime: 'claude',
  executionTarget: 'local',
  branch: 'feature/dark-mode',
  userId: 'user-1',
  maxValidationAttempts: 3,
  skipValidation: false,
  outputMode: 'pr',
};

describe('PodRepository', () => {
  let db: Database.Database;
  let repo: PodRepository;

  beforeEach(() => {
    db = createTestDb();
    seedProfile(db);
    repo = createPodRepository(db);
  });

  describe('insert', () => {
    it('should insert a pod and read it back', () => {
      repo.insert(validSession);
      const pod = repo.getOrThrow('sess-001');
      expect(pod.id).toBe('sess-001');
      expect(pod.profileName).toBe('test-app');
      expect(pod.task).toBe('Add a dark mode toggle');
      expect(pod.status).toBe('queued');
      expect(pod.model).toBe('opus');
      expect(pod.runtime).toBe('claude');
      expect(pod.branch).toBe('feature/dark-mode');
      expect(pod.userId).toBe('user-1');
      expect(pod.maxValidationAttempts).toBe(3);
      expect(pod.skipValidation).toBe(false);
    });

    it('should set defaults for optional DB columns', () => {
      repo.insert(validSession);
      const pod = repo.getOrThrow('sess-001');
      expect(pod.containerId).toBeNull();
      expect(pod.worktreePath).toBeNull();
      expect(pod.validationAttempts).toBe(0);
      expect(pod.lastValidationResult).toBeNull();
      expect(pod.pendingEscalation).toBeNull();
      expect(pod.escalationCount).toBe(0);
      expect(pod.startedAt).toBeNull();
      expect(pod.completedAt).toBeNull();
      expect(pod.filesChanged).toBe(0);
      expect(pod.linesAdded).toBe(0);
      expect(pod.linesRemoved).toBe(0);
      expect(pod.previewUrl).toBeNull();
    });

    it('should store skipValidation=true as 1 and read back as true', () => {
      repo.insert({ ...validSession, id: 'sess-skip', skipValidation: true });
      const pod = repo.getOrThrow('sess-skip');
      expect(pod.skipValidation).toBe(true);
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

    it('should store and retrieve pimGroups as JSON', () => {
      repo.insert({
        ...validSession,
        id: 'sess-pim',
        pimGroups: [
          { groupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', displayName: 'Log Reader' },
          { groupId: 'ffffffff-1111-2222-3333-444444444444', duration: 'PT4H' },
        ],
      });
      const pod = repo.getOrThrow('sess-pim');
      expect(pod.pimGroups).toEqual([
        { groupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', displayName: 'Log Reader' },
        { groupId: 'ffffffff-1111-2222-3333-444444444444', duration: 'PT4H' },
      ]);
    });

    it('should default pimGroups to null when not provided', () => {
      repo.insert(validSession);
      const pod = repo.getOrThrow('sess-001');
      expect(pod.pimGroups).toBeNull();
    });
  });

  describe('getOrThrow', () => {
    it('should throw PodNotFoundError for nonexistent id', () => {
      expect(() => repo.getOrThrow('nope')).toThrow(PodNotFoundError);
    });
  });

  describe('update', () => {
    it('should update status', () => {
      repo.insert(validSession);
      repo.update('sess-001', { status: 'running' });
      const pod = repo.getOrThrow('sess-001');
      expect(pod.status).toBe('running');
    });

    it('should update multiple fields at once', () => {
      repo.insert(validSession);
      repo.update('sess-001', {
        status: 'running',
        containerId: 'ctr-abc',
        worktreePath: '/tmp/wt/sess-001',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const pod = repo.getOrThrow('sess-001');
      expect(pod.status).toBe('running');
      expect(pod.containerId).toBe('ctr-abc');
      expect(pod.worktreePath).toBe('/tmp/wt/sess-001');
      expect(pod.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should update updatedAt timestamp', () => {
      repo.insert(validSession);
      repo.getOrThrow('sess-001').updatedAt;
      // Force a known old timestamp
      db.prepare(
        "UPDATE pods SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'sess-001'",
      ).run();
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
      const pod = repo.getOrThrow('sess-001');
      expect(pod.lastValidationResult).toEqual(result);
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
      const pod = repo.getOrThrow('sess-001');
      expect(pod.pendingEscalation).toEqual(escalation);
    });

    it('should be a no-op for empty changes', () => {
      repo.insert(validSession);
      repo.update('sess-001', {});
      // Should not throw, pod unchanged
      const pod = repo.getOrThrow('sess-001');
      expect(pod.status).toBe('queued');
    });

    it('should throw PodNotFoundError for nonexistent id', () => {
      expect(() => repo.update('nope', { status: 'running' })).toThrow(PodNotFoundError);
    });

    it('should update diff stats', () => {
      repo.insert(validSession);
      repo.update('sess-001', { filesChanged: 5, linesAdded: 120, linesRemoved: 30 });
      const pod = repo.getOrThrow('sess-001');
      expect(pod.filesChanged).toBe(5);
      expect(pod.linesAdded).toBe(120);
      expect(pod.linesRemoved).toBe(30);
    });

    it('should update previewUrl', () => {
      repo.insert(validSession);
      repo.update('sess-001', { previewUrl: 'http://localhost:3000' });
      expect(repo.getOrThrow('sess-001').previewUrl).toBe('http://localhost:3000');
    });
  });

  describe('list', () => {
    it('should return all pods ordered by created_at DESC', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', task: 'Second task' });
      // Force different timestamps so ordering is deterministic
      db.prepare(
        "UPDATE pods SET created_at = '2026-01-01T00:00:00' WHERE id = 'sess-001'",
      ).run();
      db.prepare(
        "UPDATE pods SET created_at = '2026-01-02T00:00:00' WHERE id = 'sess-002'",
      ).run();

      const pods = repo.list();
      expect(pods).toHaveLength(2);
      // Most recent first
      expect(pods[0]?.id).toBe('sess-002');
      expect(pods[1]?.id).toBe('sess-001');
    });

    it('should return empty array when no pods', () => {
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
      expect(filtered[0]?.profileName).toBe('test-app');
    });

    it('should filter by status', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', status: 'running' as const });
      const filtered = repo.list({ status: 'queued' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.status).toBe('queued');
    });

    it('should filter by userId', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', userId: 'user-2' });
      const filtered = repo.list({ userId: 'user-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.userId).toBe('user-1');
    });

    it('should combine multiple filters', () => {
      repo.insert(validSession);
      repo.insert({ ...validSession, id: 'sess-002', status: 'running' as const });
      repo.insert({ ...validSession, id: 'sess-003', userId: 'user-2' });

      const filtered = repo.list({ status: 'queued', userId: 'user-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('sess-001');
    });
  });

  describe('countByStatusAndProfile', () => {
    it('should count matching pods', () => {
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

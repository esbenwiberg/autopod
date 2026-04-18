import fs from 'node:fs';
import path from 'node:path';
import type { SystemEvent } from '@autopod/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type EventRepository, createEventRepository } from './event-repository.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../db/migrations');
const MIGRATION_FILES = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of MIGRATION_FILES) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const needsFkDisabled = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    if (needsFkDisabled) db.pragma('foreign_keys = OFF');
    for (const stmt of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        db.exec(`${stmt};`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
    if (needsFkDisabled) db.pragma('foreign_keys = ON');
  }
  return db;
}

function seedSessionWithProfile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES ('test-app', 'https://github.com/org/repo', 'npm build', 'node app.js')`,
  ).run();
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES ('sess-001', 'test-app', 'test task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
  ).run();
}

describe('EventRepository', () => {
  let db: Database.Database;
  let repo: EventRepository;

  beforeEach(() => {
    db = createTestDb();
    seedSessionWithProfile(db);
    repo = createEventRepository(db);
  });

  describe('insert', () => {
    it('should insert an event and return an auto-increment id', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      const id = repo.insert(event);
      expect(id).toBeGreaterThan(0);
    });

    it('should return incrementing ids', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      const id1 = repo.insert(event);
      const id2 = repo.insert(event);
      expect(id2).toBe(id1 + 1);
    });

    it('should extract podId from event with podId field', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      repo.insert(event);
      const events = repo.getForSession('sess-001');
      expect(events).toHaveLength(1);
      expect(events[0]?.podId).toBe('sess-001');
    });

    it('should extract podId from pod.created event via pod.id', () => {
      const event: SystemEvent = {
        type: 'pod.created',
        timestamp: new Date().toISOString(),
        pod: {
          id: 'sess-001',
          profileName: 'test-app',
          task: 'test',
          status: 'queued',
          model: 'opus',
          runtime: 'claude',
          duration: null,
          filesChanged: 0,
          createdAt: new Date().toISOString(),
        },
      };
      repo.insert(event);
      const events = repo.getForSession('sess-001');
      expect(events).toHaveLength(1);
    });

    it('should store full event payload as JSON', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: '2026-01-01T00:00:00.000Z',
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      repo.insert(event);
      const stored = repo.getForSession('sess-001');
      expect(stored[0]?.payload).toEqual(event);
      expect(stored[0]?.type).toBe('pod.status_changed');
    });
  });

  describe('getSince', () => {
    it('should return events with id > lastId', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      const id1 = repo.insert(event);
      const id2 = repo.insert({ ...event, newStatus: 'validating' as const });
      repo.insert({ ...event, newStatus: 'complete' as const });

      const events = repo.getSince(id1);
      expect(events).toHaveLength(2);
      expect(events[0]?.id).toBe(id2);
    });

    it('should return empty array when no events after lastId', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      const id = repo.insert(event);
      expect(repo.getSince(id)).toEqual([]);
    });

    it('should return all events when lastId is 0', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      repo.insert(event);
      repo.insert(event);
      expect(repo.getSince(0)).toHaveLength(2);
    });

    it('should return events in ascending order', () => {
      const event: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      repo.insert(event);
      repo.insert(event);
      repo.insert(event);
      const events = repo.getSince(0);
      expect(events[0]?.id).toBeLessThan(events[1]?.id);
      expect(events[1]?.id).toBeLessThan(events[2]?.id);
    });
  });

  describe('getForSession', () => {
    it('should return only events for the given pod', () => {
      // Create another pod
      db.prepare(
        `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
         VALUES ('sess-002', 'test-app', 'other task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
      ).run();

      const event1: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-001',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      const event2: SystemEvent = {
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: 'sess-002',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      repo.insert(event1);
      repo.insert(event2);
      repo.insert(event1);

      const events = repo.getForSession('sess-001');
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.podId === 'sess-001')).toBe(true);
    });

    it('should return empty array for pod with no events', () => {
      expect(repo.getForSession('sess-001')).toEqual([]);
    });
  });
});

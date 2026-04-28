import fs from 'node:fs';
import path from 'node:path';
import type { SystemEvent } from '@autopod/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type EventRepository, createEventRepository } from '../pods/event-repository.js';
import { type ReplaySocket, replayEvents } from './websocket.js';

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

function seedProfileAndPod(db: Database.Database): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES ('test-app', 'https://github.com/org/repo', 'npm build', 'node app.js')`,
  ).run();
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES ('sess-001', 'test-app', 'test task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
  ).run();
}

class MockSocket implements ReplaySocket {
  readyState = 1;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = this.CLOSED;
  }
}

function makeStatusEvent(): SystemEvent {
  return {
    type: 'pod.status_changed',
    timestamp: '2026-01-01T00:00:00.000Z',
    podId: 'sess-001',
    previousStatus: 'queued',
    newStatus: 'running',
  };
}

describe('replayEvents', () => {
  let db: Database.Database;
  let repo: EventRepository;

  beforeEach(() => {
    db = createTestDb();
    seedProfileAndPod(db);
    repo = createEventRepository(db);
  });

  it('replays all pending events and emits replay_complete', async () => {
    const event = makeStatusEvent();
    for (let i = 0; i < 1500; i++) repo.insert(event);
    const socket = new MockSocket();

    await replayEvents(socket, repo, 0, { pageSize: 200, maxEvents: 10_000 });

    // 1500 event payloads + the trailing replay_complete signal
    expect(socket.sent).toHaveLength(1501);
    const last = JSON.parse(socket.sent[1500] as string);
    expect(last.type).toBe('replay_complete');
    expect(last.lastEventId).toBeGreaterThanOrEqual(1500);

    const firstPayload = JSON.parse(socket.sent[0] as string);
    expect(firstPayload._eventId).toBeGreaterThan(0);
    expect(firstPayload.podId).toBe('sess-001');
  });

  it('yields between pages so the event loop is not blocked', async () => {
    const event = makeStatusEvent();
    for (let i = 0; i < 600; i++) repo.insert(event);
    const socket = new MockSocket();

    let interleavedTicks = 0;
    const interval = setInterval(() => {
      interleavedTicks++;
    }, 0);

    try {
      await replayEvents(socket, repo, 0, { pageSize: 100, maxEvents: 10_000 });
    } finally {
      clearInterval(interval);
    }

    // With pageSize=100 and 600 events we have 6 pages → at least 5 yields.
    // The interval timer should have been able to fire between pages.
    expect(interleavedTicks).toBeGreaterThan(0);
  });

  it('emits replay_truncated when the cap is hit and more events remain', async () => {
    const event = makeStatusEvent();
    for (let i = 0; i < 250; i++) repo.insert(event);
    const socket = new MockSocket();

    await replayEvents(socket, repo, 0, { pageSize: 50, maxEvents: 100 });

    // 100 payloads + truncation signal
    expect(socket.sent).toHaveLength(101);
    const signal = JSON.parse(socket.sent[100] as string);
    expect(signal.type).toBe('replay_truncated');
    expect(signal.reason).toBe('too_many_events');
    expect(signal.resumeFromEventId).toBeGreaterThan(0);
  });

  it('emits replay_complete when the cap matches the backlog exactly', async () => {
    const event = makeStatusEvent();
    for (let i = 0; i < 100; i++) repo.insert(event);
    const socket = new MockSocket();

    await replayEvents(socket, repo, 0, { pageSize: 50, maxEvents: 100 });

    expect(socket.sent).toHaveLength(101);
    const signal = JSON.parse(socket.sent[100] as string);
    expect(signal.type).toBe('replay_complete');
  });

  it('aborts cleanly if the socket closes mid-replay', async () => {
    const event = makeStatusEvent();
    for (let i = 0; i < 1000; i++) repo.insert(event);
    const socket = new MockSocket();

    // Close after the first chunk of sends. The original send remains on the
    // mock so we can flip readyState before the loop's next page read.
    const realSend = socket.send.bind(socket);
    let sendCount = 0;
    socket.send = (data: string) => {
      realSend(data);
      sendCount++;
      if (sendCount === 50) socket.close();
    };

    await replayEvents(socket, repo, 0, { pageSize: 100, maxEvents: 10_000 });

    // Exactly the events written before the close — no completion signal should
    // be emitted because the socket is no longer OPEN.
    expect(socket.sent).toHaveLength(50);
    expect(socket.sent.every((s) => !s.includes('replay_complete'))).toBe(true);
    expect(socket.sent.every((s) => !s.includes('replay_truncated'))).toBe(true);
  });

  it('replays nothing when there are no events past lastEventId', async () => {
    const event = makeStatusEvent();
    const lastId = repo.insert(event);
    const socket = new MockSocket();

    await replayEvents(socket, repo, lastId);

    expect(socket.sent).toHaveLength(1);
    const signal = JSON.parse(socket.sent[0] as string);
    expect(signal.type).toBe('replay_complete');
    expect(signal.lastEventId).toBe(lastId);
  });
});

import type { SystemEvent } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventRepository } from '../../pods/event-repository.js';
import type { EventRepository } from '../../pods/event-repository.js';
import type { PodManager } from '../../pods/index.js';
import { createTestDb, insertTestProfile } from '../../test-utils/mock-helpers.js';
import { podRoutes } from './pods.js';

function agentActivity(message: string): SystemEvent {
  return {
    type: 'pod.agent_activity',
    timestamp: new Date().toISOString(),
    podId: 'sess-001',
    event: {
      type: 'status',
      timestamp: new Date().toISOString(),
      message,
    },
  };
}

describe('GET /pods/:podId/events', () => {
  let db: ReturnType<typeof createTestDb>;
  let eventRepo: EventRepository;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = createTestDb();
    insertTestProfile(db);
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
       VALUES ('sess-001', 'test-profile', 'test task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    eventRepo = createEventRepository(db);
    app = Fastify();
    podRoutes(
      app,
      {
        getSession: () => ({ id: 'sess-001' }),
      } as unknown as PodManager,
      eventRepo,
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns all agent activity events when no limit is provided', async () => {
    eventRepo.insert(agentActivity('first'));
    eventRepo.insert(agentActivity('second'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ message: 'first' }, { message: 'second' }]);
  });

  it('returns the latest limited agent activity events in chronological order', async () => {
    const statusEvent: SystemEvent = {
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: 'sess-001',
      previousStatus: 'queued',
      newStatus: 'running',
    };

    for (let i = 1; i <= 550; i++) {
      eventRepo.insert(agentActivity(`message-${i}`));
      eventRepo.insert(statusEvent);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events?limit=500',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ message: string }>;
    expect(body).toHaveLength(500);
    expect(body[0]?.message).toBe('message-51');
    expect(body[499]?.message).toBe('message-550');
  });

  it('rejects invalid limits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events?limit=0',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_limit' });
  });
});

import type { SystemEvent } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActionAuditRepository } from '../../actions/audit-repository.js';
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

function firewallDenied(
  sni: string,
  src = '172.19.0.2',
  timestamp = new Date().toISOString(),
): SystemEvent {
  return {
    type: 'pod.firewall_denied',
    timestamp,
    podId: 'sess-001',
    sni,
    src,
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
    const firstId = eventRepo.insert(agentActivity('first'));
    const secondId = eventRepo.insert(agentActivity('second'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { eventId: firstId, message: 'first' },
      { eventId: secondId, message: 'second' },
    ]);
  });

  it('returns firewall denials as replayable log events', async () => {
    const firstId = eventRepo.insert(agentActivity('first'));
    const denialId = eventRepo.insert(firewallDenied('oraios-software.de'));
    const secondId = eventRepo.insert(agentActivity('second'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { eventId: firstId, type: 'status', message: 'first' },
      {
        eventId: denialId,
        type: 'firewall_denied',
        message: 'Denied egress: oraios-software.de',
        output: 'Source: 172.19.0.2',
        sni: 'oraios-software.de',
        src: '172.19.0.2',
      },
      { eventId: secondId, type: 'status', message: 'second' },
    ]);
  });

  it('returns stable event ids', async () => {
    const id = eventRepo.insert(agentActivity('stable'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        eventId: id,
        type: 'status',
        message: 'stable',
      }),
    ]);
  });

  it('returns the latest limited log replay events in chronological order', async () => {
    const statusEvent: SystemEvent = {
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: 'sess-001',
      previousStatus: 'queued',
      newStatus: 'running',
    };

    for (let i = 1; i <= 550; i++) {
      eventRepo.insert(agentActivity(`message-${i}`));
      if (i === 549) {
        eventRepo.insert(firewallDenied('blocked.example.com'));
      }
      eventRepo.insert(statusEvent);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/events?limit=500',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ message: string }>;
    expect(body).toHaveLength(500);
    expect(body[0]?.message).toBe('message-52');
    expect(body[496]?.message).toBe('message-548');
    expect(body[497]?.message).toBe('message-549');
    expect(body[498]?.message).toBe('Denied egress: blocked.example.com');
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

describe('GET /pods/:podId/firewall-denials', () => {
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

  it('returns structured firewall-denial rows only', async () => {
    eventRepo.insert(agentActivity('hidden'));
    const firstId = eventRepo.insert(firewallDenied('oraios-software.de'));
    const secondId = eventRepo.insert(firewallDenied('http-intake.logs.us5.datadoghq.com'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/firewall-denials',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      {
        eventId: firstId,
        sni: 'oraios-software.de',
        src: '172.19.0.2',
      },
      {
        eventId: secondId,
        sni: 'http-intake.logs.us5.datadoghq.com',
        src: '172.19.0.2',
      },
    ]);
  });

  it('returns latest limited firewall denials in chronological order', async () => {
    for (let i = 1; i <= 3; i++) {
      eventRepo.insert(firewallDenied(`blocked-${i}.example.com`));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/firewall-denials?limit=2',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ sni: string }>;
    expect(body.map((row) => row.sni)).toEqual(['blocked-2.example.com', 'blocked-3.example.com']);
  });

  it('can return rows visible at a readiness snapshot timestamp', async () => {
    eventRepo.insert(firewallDenied('first.example.com', '172.19.0.2', '2026-06-08T07:32:18.686Z'));
    eventRepo.insert(
      firewallDenied('second.example.com', '172.19.0.2', '2026-06-08T07:32:18.694Z'),
    );
    eventRepo.insert(firewallDenied('later.example.com', '172.19.0.2', '2026-06-08T07:39:57.825Z'));

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/firewall-denials?until=2026-06-08T07:33:09.324Z',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ sni: string }>;
    expect(body.map((row) => row.sni)).toEqual(['first.example.com', 'second.example.com']);
  });

  it('rejects invalid firewall-denial limits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/firewall-denials?limit=0',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_limit' });
  });

  it('rejects invalid firewall-denial until timestamps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/firewall-denials?until=nope',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_until' });
  });
});

describe('GET /pods/:podId/action-audit', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof Fastify>;
  let actionAuditRepo: ReturnType<typeof createActionAuditRepository>;

  beforeEach(async () => {
    db = createTestDb();
    insertTestProfile(db);
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
       VALUES ('sess-001', 'test-profile', 'test task', 'queued', 'opus', 'claude', 'main', 'user-1')`,
    ).run();
    actionAuditRepo = createActionAuditRepository(db);
    app = Fastify();
    podRoutes(
      app,
      {
        getSession: () => ({ id: 'sess-001' }),
      } as unknown as PodManager,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      actionAuditRepo,
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns action audit rows with chain status', async () => {
    actionAuditRepo.insert({
      podId: 'sess-001',
      actionName: 'azure.deploy',
      params: { app: 'guardian', slot: 'staging' },
      responseSummary: 'Deployment accepted.',
      piiDetected: true,
      quarantineScore: 0.2,
      piiCategories: ['email'],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rows: [
        {
          podId: 'sess-001',
          actionName: 'azure.deploy',
          params: { app: 'guardian', slot: 'staging' },
          responseSummary: 'Deployment accepted.',
          piiDetected: true,
          quarantineScore: 0.2,
          piiCategories: ['email'],
        },
      ],
      chain: { valid: true, rowCount: 1 },
    });
  });

  it('returns latest limited action audit rows', async () => {
    for (let i = 1; i <= 3; i++) {
      actionAuditRepo.insert({
        podId: 'sess-001',
        actionName: `action-${i}`,
        params: {},
        responseSummary: null,
        piiDetected: false,
        quarantineScore: 0,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit?limit=2',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ actionName: string }> };
    expect(body.rows.map((row) => row.actionName)).toEqual(['action-3', 'action-2']);
  });

  it('can return rows visible at a readiness snapshot timestamp', async () => {
    db.prepare(
      `INSERT INTO action_audit
         (pod_id, action_name, params, pii_detected, quarantine_score, created_at)
       VALUES
         (@podId, @actionName, '{}', 0, 0, @createdAt)`,
    ).run({
      podId: 'sess-001',
      actionName: 'before',
      createdAt: '2026-06-08 07:32:18',
    });
    db.prepare(
      `INSERT INTO action_audit
         (pod_id, action_name, params, pii_detected, quarantine_score, created_at)
       VALUES
         (@podId, @actionName, '{}', 0, 0, @createdAt)`,
    ).run({
      podId: 'sess-001',
      actionName: 'later',
      createdAt: '2026-06-08 07:39:57',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit?until=2026-06-08T07:33:09.324Z',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ actionName: string }> };
    expect(body.rows.map((row) => row.actionName)).toEqual(['before']);
  });

  it('rejects invalid action-audit limits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit?limit=0',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_limit' });
  });

  it('rejects invalid action-audit until timestamps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit?until=nope',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_until' });
  });

  it('returns invalid chain details', async () => {
    actionAuditRepo.insert({
      podId: 'sess-001',
      actionName: 'azure.deploy',
      params: {},
      responseSummary: null,
      piiDetected: false,
      quarantineScore: 0,
    });
    db.prepare('UPDATE action_audit SET entry_hash = @bad WHERE pod_id = @podId').run({
      bad: 'deadbeef'.repeat(8),
      podId: 'sess-001',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/sess-001/action-audit',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chain: { valid: false, rowCount: 1 },
    });
  });
});

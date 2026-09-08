import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEscalationMcpServer } from '@autopod/escalation-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createNudgeRepository } from './nudge-repository.js';
import { type SessionBridgeDependencies, createSessionBridge } from './pod-bridge-impl.js';
import { createPodRepository } from './pod-repository.js';

function seed(db: Database.Database) {
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Retain guidance',
    status: 'running',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'worker',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const runId = repo.taskExecutions?.beginRun('worker', 1, 1, {
    runtime: 'codex',
    model: 'model',
    providerAccountId: null,
  });
  if (!runId) throw new Error('Missing worker run');
  return { repo, runId, nudges: createNudgeRepository(db) };
}

async function connect(db: Database.Database) {
  const repo = createPodRepository(db);
  const nudges = createNudgeRepository(db);
  const stub = {} as never;
  const bridge = createSessionBridge({
    podManager: {
      touchHeartbeat: vi.fn(),
      getSession: (id: string) => repo.getOrThrow(id),
    } as unknown as SessionBridgeDependencies['podManager'],
    podRepo: repo,
    nudgeRepo: nudges,
    eventBus: stub,
    escalationRepo: stub,
    profileStore: stub,
    containerManagerFactory: stub,
    pendingRequestsByPod: new Map(),
    logger,
  });
  const { server } = createEscalationMcpServer({ podId: 'worker', bridge });
  const client = new Client({ name: 'guidance-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    serverTransport,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
function decode(result: { content: unknown }) {
  if (!Array.isArray(result.content)) throw new Error('Missing MCP content');
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('Missing MCP text');
  return JSON.parse(text) as {
    deliveryId: string;
    operatorMessages: string[];
    acknowledged?: boolean;
    hasMessage?: boolean;
  };
}

it.each(['check_messages', 'report_task_summary', 'ask_ai', 'validate_in_browser'] as const)(
  'retains guidance when the actual %s MCP response is dropped',
  async (tool) => {
    const db = createTestDb();
    const { nudges } = seed(db);
    nudges.queue('worker', 'Preserve the selected work and inspect the outstanding finding.');
    const { client, serverTransport, close } = await connect(db);
    try {
      const originalSend = serverTransport.send.bind(serverTransport);
      let dropped = false;
      vi.spyOn(serverTransport, 'send').mockImplementation(async (message) => {
        if ('result' in message && !dropped) {
          dropped = true;
          return;
        }
        await originalSend(message);
      });
      await expect(
        client.callTool(
          {
            name: tool,
            arguments:
              tool === 'report_task_summary'
                ? { actualSummary: 'Done', deviations: [] }
                : tool === 'ask_ai'
                  ? { question: 'Help' }
                  : tool === 'validate_in_browser'
                    ? { url: 'http://localhost', checks: ['works'] }
                    : {},
          },
          undefined,
          { timeout: 100 },
        ),
      ).rejects.toThrow();
      expect(dropped).toBe(true);
      expect(nudges.hasPending('worker')).toBe(true);
      expect(nudges.listPending('worker').map((row) => row.message)).toEqual([
        'Preserve the selected work and inspect the outstanding finding.',
      ]);
    } finally {
      await close();
      db.close();
    }
  },
);

it('replays a receipt after disk reopen and loses neither late guidance nor a dropped acknowledgment response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guidance-reopen-'));
  const file = join(dir, 'state.db');
  let db = createTestDb();
  const { nudges } = seed(db);
  nudges.queue('worker', 'Original guidance');
  let channel = await connect(db);
  try {
    const first = decode(await channel.client.callTool({ name: 'check_messages', arguments: {} }));
    expect(first.operatorMessages).toEqual(['Original guidance']);
    expect(nudges.hasPending('worker')).toBe(true);
    await channel.close();
    writeFileSync(file, db.serialize());
    db.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    channel = await connect(db);
    const recovered = createNudgeRepository(db);
    const replay = decode(await channel.client.callTool({ name: 'check_messages', arguments: {} }));
    expect(replay.deliveryId).toBe(first.deliveryId);
    recovered.queue('worker', 'Late guidance must remain pending');
    const pendingDecision = JSON.stringify({
      id: 'unanswered',
      payload: { question: 'Choose the next change' },
    });
    db.prepare('UPDATE pods SET pending_escalation=? WHERE id=?').run(pendingDecision, 'worker');
    const dropped = vi
      .spyOn(channel.serverTransport, 'send')
      .mockImplementationOnce(async () => undefined);
    await expect(
      channel.client.callTool(
        { name: 'acknowledge_messages', arguments: { deliveryId: first.deliveryId } },
        undefined,
        { timeout: 100 },
      ),
    ).rejects.toThrow();
    dropped.mockRestore();
    expect(recovered.listPending('worker').map((r) => r.message)).toEqual([
      'Late guidance must remain pending',
    ]);
    expect(
      decode(
        await channel.client.callTool({
          name: 'acknowledge_messages',
          arguments: { deliveryId: first.deliveryId },
        }),
      ).acknowledged,
    ).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM operator_guidance_acknowledgments').get(),
    ).toEqual({ count: 1 });
    const late = decode(
      await channel.client.callTool({
        name: 'report_task_summary',
        arguments: { actualSummary: 'Done', deviations: [] },
      }),
    );
    expect(late.operatorMessages).toEqual(['Late guidance must remain pending']);
    expect(late.deliveryId).not.toBe(first.deliveryId);
    expect(recovered.hasPending('worker')).toBe(true);
    await channel.client.callTool({
      name: 'acknowledge_messages',
      arguments: { deliveryId: late.deliveryId },
    });
    expect(recovered.hasPending('worker')).toBe(false);
    expect(db.prepare('SELECT pending_escalation FROM pods WHERE id=?').get('worker')).toEqual({
      pending_escalation: pendingDecision,
    });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    await channel.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['run', 'generation'] as const)(
  'rejects an old %s receipt and delivers the saved message to the replacement worker',
  (mode) => {
    const db = createTestDb();
    const { repo, runId, nudges } = seed(db);
    try {
      nudges.queue('worker', 'Preserve across replacement');
      const original = nudges.readPending('worker');
      if (!original) throw new Error('Missing original');
      expect(() => nudges.acknowledgeDelivery('other', original.deliveryId)).toThrow(
        'Unknown operator guidance',
      );
      repo.taskExecutions?.finishRun(runId, 'completed');
      if (mode === 'generation') repo.incrementLifecycleGeneration('worker');
      const generation = repo.getOrThrow('worker').lifecycleGeneration;
      repo.taskExecutions?.beginRun('worker', generation, 2, {
        runtime: 'codex',
        model: 'model',
        providerAccountId: null,
      });
      expect(() => nudges.acknowledgeDelivery('worker', original.deliveryId)).toThrow(
        'older worker',
      );
      expect(() =>
        db
          .prepare(
            'INSERT INTO operator_guidance_acknowledgments(delivery_id,acknowledged_at) VALUES (?,?)',
          )
          .run(original.deliveryId, new Date().toISOString()),
      ).toThrow('stale worker');
      expect(nudges.hasPending('worker')).toBe(true);
      const replacement = nudges.readPending('worker');
      if (!replacement) throw new Error('Missing replacement');
      expect(replacement.deliveryId).not.toBe(original.deliveryId);
      expect(replacement.messages).toEqual(original.messages);
      nudges.acknowledgeDelivery('worker', replacement.deliveryId);
      expect(nudges.hasPending('worker')).toBe(false);
    } finally {
      db.close();
    }
  },
);

it('bounds batches, retains their exact membership, and rolls back partial acknowledgment', () => {
  const db = createTestDb();
  const { nudges } = seed(db);
  try {
    for (let i = 0; i < 17; i++) nudges.queue('worker', `Guidance ${i}`);
    const first = nudges.readPending('worker');
    if (!first) throw new Error('Missing delivery');
    expect(first.messages).toHaveLength(16);
    expect(nudges.readPending('worker')).toEqual(first);
    nudges.queue('worker', 'Later arrival');
    expect(nudges.readPending('worker')).toEqual(first);
    expect(() =>
      db.prepare('UPDATE nudge_messages SET consumed=1 WHERE pod_id=?').run('worker'),
    ).toThrow('requires delivery acknowledgment');
    db.exec(
      "CREATE TRIGGER fixture_ack_fault BEFORE UPDATE ON nudge_messages WHEN NEW.consumed=1 BEGIN SELECT RAISE(ABORT,'fixture acknowledgment storage fault'); END;",
    );
    expect(() => nudges.acknowledgeDelivery('worker', first.deliveryId)).toThrow('storage fault');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM operator_guidance_acknowledgments').get(),
    ).toEqual({ count: 0 });
    expect(nudges.listPending('worker')).toHaveLength(18);
    db.exec('DROP TRIGGER fixture_ack_fault');
    nudges.acknowledgeDelivery('worker', first.deliveryId);
    expect(nudges.readPending('worker')?.messages).toEqual(['Guidance 16', 'Later arrival']);
    expect(() =>
      db
        .prepare('UPDATE operator_guidance_deliveries SET run_id=? WHERE id=?')
        .run('rewritten', first.deliveryId),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE nudge_messages SET message=? WHERE id=1').run('rewritten'),
    ).toThrow('immutable');
  } finally {
    db.close();
  }
});

it('bounds UTF-8 payloads without discarding an oversized legacy message', () => {
  const db = createTestDb();
  const { nudges } = seed(db);
  try {
    const message = '🙂'.repeat(50000);
    nudges.queue('worker', message);
    nudges.queue('worker', message);
    const first = nudges.readPending('worker');
    if (!first) throw new Error('Missing delivery');
    expect(first.messages).toEqual([message]);
    nudges.acknowledgeDelivery('worker', first.deliveryId);
    const second = nudges.readPending('worker');
    if (!second) throw new Error('Missing second delivery');
    nudges.acknowledgeDelivery('worker', second.deliveryId);
    nudges.queue('worker', 'x'.repeat(256 * 1024 + 1));
    expect(() => nudges.readPending('worker')).toThrow('exceeds the bounded delivery size');
    expect(nudges.hasPending('worker')).toBe(true);
  } finally {
    db.close();
  }
});

it('upgrades schema 179 without inventing acknowledgment of consumed legacy rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guidance-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= 179) copyFileSync(join(migrations, file), join(dir, file));
  const db = new Database(join(dir, 'state.db'));
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db, dir, logger);
    const { repo, runId, nudges } = seed(db);
    nudges.queue('worker', 'Retain pending legacy guidance');
    db.prepare(
      "INSERT INTO nudge_messages(pod_id,message,consumed,created_at,consumed_at) VALUES ('worker','Legacy consumed without receipt',1,'2026-09-07T00:00:00Z','2026-09-07T01:00:00Z')",
    ).run();
    const before = db.prepare('SELECT * FROM nudge_messages ORDER BY id').all();
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT * FROM nudge_messages ORDER BY id').all()).toEqual(before);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM operator_guidance_acknowledgments').get(),
    ).toEqual({ count: 0 });
    const delivery = nudges.readPending('worker');
    if (!delivery) throw new Error('Missing legacy delivery');
    expect(delivery.messages).toEqual(['Retain pending legacy guidance']);
    nudges.acknowledgeDelivery('worker', delivery.deliveryId);
    repo.taskExecutions?.finishRun(runId, 'completed');
    repo.delete('worker');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM operator_guidance_acknowledgments').get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM retained_nudge_messages WHERE pod_id=?')
        .get('worker'),
    ).toEqual({ count: 2 });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

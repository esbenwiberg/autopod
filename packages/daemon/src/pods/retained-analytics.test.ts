import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createHistoryExporter } from '../history/history-exporter.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createProgressEventRepository } from './progress-event-repository.js';
import { computeReliabilityAnalytics } from './reliability-aggregator.js';
import { computeThroughputAnalytics } from './throughput-aggregator.js';
import { createValidationRepository } from './validation-repository.js';

function seed() {
  const ctx = createTestContext();
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const validationRepo = createValidationRepository(ctx.db);
  for (const id of ['success', 'failure']) {
    ctx.podRepo.insert({
      id,
      profileName: 'test-profile',
      task: 'Retain historical observations',
      status: id === 'success' ? 'complete' : 'failed',
      model: 'fixture-model',
      runtime: 'codex',
      executionTarget: 'local',
      branch: id,
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    ctx.db
      .prepare('UPDATE pods SET created_at=?,started_at=?,completed_at=? WHERE id=?')
      .run(at(120), at(110), at(60), id);
    const result = createPassingValidationResult(id, 1);
    if (id === 'failure') {
      result.overall = 'fail';
      result.smoke.build.status = 'fail';
    }
    validationRepo.insert(id, 1, result);
    for (const [index, status] of [
      'queued',
      'running',
      'validating',
      id === 'success' ? 'complete' : 'failed',
    ].entries()) {
      ctx.db
        .prepare('INSERT INTO events(pod_id,type,payload,created_at) VALUES (?,?,?,?)')
        .run(
          id,
          'pod.status_changed',
          JSON.stringify({ type: 'pod.status_changed', podId: id, newStatus: status }),
          at(120 - index * 20),
        );
    }
  }
  const exporter = createHistoryExporter({
    ...ctx,
    eventRepo: createEventRepository(ctx.db),
    validationRepo,
    progressEventRepo: createProgressEventRepository(ctx.db),
  });
  return { ...ctx, exporter };
}

it.each(['reliability', 'throughput'] as const)(
  'retains %s observations and denominator after actual pod deletion',
  (metric) => {
    const ctx = seed();
    try {
      const measure = () =>
        metric === 'reliability'
          ? computeReliabilityAnalytics(ctx.db, 1)
          : computeThroughputAnalytics(ctx.db, 1);
      const before = measure();
      ctx.podRepo.delete('failure');
      const after = measure();
      const measurements = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (key, item) => (key === 'historyArchived' ? undefined : item)),
        );
      expect(measurements(after)).toEqual(measurements(before));
      expect(JSON.stringify(after)).toContain('"historyArchived":true');
    } finally {
      ctx.db.close();
    }
  },
);

it('retains exported pod and validation observations after actual deletion', () => {
  const ctx = seed();
  try {
    const before = ctx.exporter.export({ limit: 10 });
    ctx.podRepo.delete('failure');
    const after = ctx.exporter.export({ limit: 10 });
    expect(after.stats).toEqual(before.stats);
    const exported = new Database(after.dbBuffer);
    try {
      expect(exported.prepare('SELECT id FROM pods ORDER BY id').all()).toEqual([
        { id: 'failure' },
        { id: 'success' },
      ]);
      expect(
        exported.prepare("SELECT overall FROM validations WHERE pod_id='failure'").all(),
      ).toEqual([{ overall: 'fail' }]);
    } finally {
      exported.close();
    }
  } finally {
    ctx.db.close();
  }
});

it.each(['{broken', 'null', '[]', '{}'])(
  'exports healthy evidence with diagnostics for retained legacy JSON %s',
  (malformed) => {
    const ctx = seed();
    try {
      ctx.db
        .prepare("UPDATE pods SET plan=?,task_summary=? WHERE id='failure'")
        .run('{broken', JSON.stringify({ actualSummary: 'x'.repeat(70_000) }));
      ctx.db
        .prepare(
          "INSERT INTO validations(id,pod_id,attempt,sequence,result) VALUES ('bad-validation','failure',2,2,?)",
        )
        .run(malformed);
      ctx.db
        .prepare(
          "INSERT INTO events(pod_id,type,payload) VALUES ('failure','pod.agent_activity',?)",
        )
        .run(malformed);
      ctx.podRepo.delete('failure');
      const result = ctx.exporter.export({ limit: 10 });
      expect(result.stats.totalSessions).toBe(2);
      const exported = new Database(result.dbBuffer);
      try {
        expect(
          exported.prepare("SELECT overall FROM validations WHERE pod_id='failure'").all(),
        ).toContainEqual({ overall: 'fail' });
        expect(
          exported
            .prepare('SELECT field,code FROM record_diagnostics WHERE pod_id=?')
            .all('failure'),
        ).toEqual(
          expect.arrayContaining([
            { field: 'plan', code: 'invalid_json' },
            { field: 'task_summary', code: 'size_limit' },
            {
              field: 'validations:bad-validation',
              code: malformed === '{broken' ? 'invalid_json' : 'invalid_shape',
            },
            { field: 'events', code: malformed === '{broken' ? 'invalid_json' : 'invalid_shape' },
          ]),
        );
      } finally {
        exported.close();
      }
    } finally {
      ctx.db.close();
    }
  },
);

it.each(['bytes', 'rows'] as const)(
  'bounds retained export event %s and reports unavailable evidence explicitly',
  (bound) => {
    const ctx = seed();
    try {
      const insert = ctx.db.prepare(
        "INSERT INTO events(pod_id,type,payload) VALUES ('failure','pod.agent_activity',?)",
      );
      if (bound === 'bytes')
        insert.run(
          JSON.stringify({
            event: {
              type: 'error',
              message: 'x'.repeat(2 * 1024 * 1024),
              timestamp: '2026-09-08T00:00:00Z',
            },
          }),
        );
      else
        ctx.db.transaction(() => {
          for (let index = 0; index < 1001; index++)
            insert.run(
              JSON.stringify({
                event: {
                  type: 'error',
                  message: 'Retained error',
                  timestamp: '2026-09-08T00:00:00Z',
                },
              }),
            );
        })();
      ctx.podRepo.delete('failure');
      const result = ctx.exporter.export({ limit: 10 });
      const exported = new Database(result.dbBuffer);
      try {
        expect(result.stats.totalSessions).toBe(2);
        expect(result.summary).toContain('Evidence diagnostics: 1');
        expect(
          exported
            .prepare("SELECT field,code FROM record_diagnostics WHERE pod_id='failure'")
            .all(),
        ).toContainEqual({ field: 'events', code: 'size_limit' });
        expect(
          exported.prepare("SELECT overall FROM validations WHERE pod_id='failure'").all(),
        ).toEqual([{ overall: 'fail' }]);
        expect(result.dbBuffer.byteLength).toBeLessThan(1024 * 1024);
      } finally {
        exported.close();
      }
    } finally {
      ctx.db.close();
    }
  },
);

it('pins the export snapshot when a second SQLite connection changes evidence after its size check', () => {
  const ctx = seed();
  const dir = mkdtempSync(join(tmpdir(), 'history-snapshot-'));
  const file = join(dir, 'state.db');
  ctx.db
    .prepare("INSERT INTO events(pod_id,type,payload) VALUES ('failure','pod.agent_activity',?)")
    .run(
      JSON.stringify({
        event: {
          type: 'error',
          message: 'Original observed failure',
          timestamp: '2026-09-08T00:00:00Z',
        },
      }),
    );
  writeFileSync(file, ctx.db.serialize());
  ctx.db.close();
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const writer = new Database(file);
  const exporter = createHistoryExporter({
    podRepo: createPodRepository(db),
    eventRepo: createEventRepository(db),
    escalationRepo: createEscalationRepository(db),
    validationRepo: createValidationRepository(db),
    progressEventRepo: createProgressEventRepository(db),
  });
  const prepare = db.prepare.bind(db);
  let changed = false;
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes('COUNT(*) AS count') && sql.includes('FROM retained_events')) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        const size = get(...args);
        if (!changed && args[0] === 'failure') {
          changed = true;
          writer
            .prepare(
              "UPDATE events SET payload=? WHERE pod_id='failure' AND type='pod.agent_activity'",
            )
            .run(
              JSON.stringify({
                event: {
                  type: 'error',
                  message: 'x'.repeat(3 * 1024 * 1024),
                  timestamp: '2026-09-08T00:00:00Z',
                },
              }),
            );
        }
        return size;
      });
    }
    return statement;
  });
  try {
    const result = exporter.export({ limit: 10 });
    expect(changed).toBe(true);
    const artifact = new Database(result.dbBuffer);
    try {
      expect(artifact.prepare("SELECT message FROM errors WHERE pod_id='failure'").all()).toEqual([
        { message: 'Original observed failure' },
      ]);
    } finally {
      artifact.close();
    }
  } finally {
    spy.mockRestore();
    writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

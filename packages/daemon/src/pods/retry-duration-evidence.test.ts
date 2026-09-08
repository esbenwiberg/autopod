import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';

it('reports missing duration for a completed legacy worker instead of implying complete zero-time evidence', () => {
  const ctx = createTestContext();
  try {
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Keep missing duration visible' },
      'operator',
    );
    const run = ctx.podRepo.taskExecutions?.beginRun(pod.id, pod.lifecycleGeneration, 1, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
    });
    if (!run) throw new Error('Missing run');
    ctx.podRepo.taskExecutions?.finishRun(run, 'completed', null);
    const state = ctx.podRepo.workerRetries?.state(pod.id);
    expect(state?.interruptedCount).toBe(0);
    expect(state).toMatchObject({
      measuredDurationMs: 0,
      durationEvidence: {
        measuredRecordCount: 0,
        unavailableRecordCount: 1,
        pendingRecordCount: 0,
        additiveAcrossStages: false,
      },
    });
  } finally {
    ctx.db.close();
  }
});

it.each([false, true])(
  'keeps duration coverage through deletion and disk reopen (unsafe sum: %s)',
  (overflow) => {
    const ctx = createTestContext();
    const dir = mkdtempSync(join(tmpdir(), 'duration-evidence-'));
    let reopened: Database.Database | undefined;
    try {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Keep time evidence' },
        'operator',
      );
      const values = overflow
        ? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
        : [10, 0, null, -2, 'corrupt', 1.5, 1e200];
      values.forEach((value, index) =>
        ctx.db
          .prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,admitted_at,not_before,started_at,ended_at,outcome,measured_duration_ms)
      SELECT ?,task_id,pod_id,execution_id,1,'validation','{}','binding','2026-09-08','2026-09-08','2026-09-08','2026-09-08','pass',? FROM task_executions WHERE pod_id=?`)
          .run(`duration-${index}`, value, pod.id),
      );
      const before = ctx.podRepo.taskRetries?.state(pod.id);
      expect(before).toMatchObject({
        measuredDurationMs: overflow ? null : 10,
        durationEvidence: {
          measuredRecordCount: 2,
          unavailableRecordCount: overflow ? 0 : 5,
          pendingRecordCount: 0,
          additiveAcrossStages: false,
        },
      });
      if (!overflow) expect(before?.latest?.measuredDurationMs).toBeNull();
      ctx.podRepo.delete(pod.id);
      const file = join(dir, 'state.db');
      writeFileSync(file, ctx.db.serialize());
      reopened = new Database(file);
      expect(createPodRepository(reopened).taskRetries?.state(pod.id)).toEqual(before);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      reopened?.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('separates a pending reservation from measured zero and unavailable settled evidence', () => {
  const ctx = createTestContext();
  try {
    const pod = createPodManager(ctx.deps).createSession(
      { profileName: 'test-profile', task: 'Pending is not measured' },
      'operator',
    );
    ctx.podRepo.taskRetries?.admit(
      pod.id,
      pod.lifecycleGeneration,
      { source: null, contract: null, commands: null, environment: null, implementation: null },
      'a'.repeat(64),
      [],
    );
    expect(ctx.podRepo.taskRetries?.state(pod.id)).toMatchObject({
      measuredDurationMs: 0,
      durationEvidence: {
        measuredRecordCount: 0,
        unavailableRecordCount: 0,
        pendingRecordCount: 1,
      },
    });
  } finally {
    ctx.db.close();
  }
});

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeCostWithCache } from '@autopod/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createTokenTelemetryRepair } from './token-telemetry-repair.js';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function seedPod(
  db: ReturnType<typeof createTestDb>,
  id: string,
  runtime: 'codex' | 'claude',
): void {
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation, completed_at,
      output_mode, agent_mode, output_target, validate, promotable
    ) VALUES (
      ?, 'test-profile', 'task', 'complete', ?, ?, 'local', ?,
      'user', 3, 0, '2026-07-30T11:00:00.000Z',
      'pr', 'auto', 'pr', 1, 0
    )
  `).run(id, runtime === 'codex' ? 'gpt-5' : 'claude-sonnet-5', runtime, `branch-${id}`);
}

function openAndCloseAttempt(
  repository: ReturnType<typeof createProviderAttemptRepository>,
  podId: string,
  runtime: 'codex' | 'claude',
): void {
  repository.open({
    podId,
    provider: runtime === 'codex' ? 'openai' : 'max',
    providerAccountId: `${runtime}-account`,
    runtime,
    model: runtime === 'codex' ? 'gpt-5' : 'claude-sonnet-5',
    profileReference: `pod:${podId}@profile-snapshot#abcdef1`,
    profileSnapshot: { name: 'test-profile' },
    startedAt: '2026-07-30T10:00:00.000Z',
  });
  repository.close(podId, {
    nativeSessionId: `${runtime}-session`,
    endedAt: '2026-07-30T10:30:00.000Z',
    outcome: 'completed',
    inputTokens: 2000,
    outputTokens: 200,
    costUsd: 2,
  });
}

async function writeRollout(root: string, podId: string): Promise<void> {
  const dir = path.join(root, podId, '2026', '07', '30');
  await mkdir(dir, { recursive: true });
  const event = (timestamp: string, id: string, last: Record<string, number>) =>
    JSON.stringify({
      timestamp,
      id,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 9999, output_tokens: 999 },
          last_token_usage: last,
        },
      },
    });
  await writeFile(
    path.join(dir, 'rollout-codex-session.jsonl'),
    [
      event('2026-07-30T10:05:00.000Z', 'call-1', {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
      }),
      event('2026-07-30T10:10:00.000Z', 'call-2', {
        input_tokens: 150,
        cached_input_tokens: 100,
        output_tokens: 20,
      }),
      // A duplicate copy from another channel must not be counted twice.
      event('2026-07-30T10:10:00.000Z', 'call-2', {
        input_tokens: 150,
        cached_input_tokens: 100,
        output_tokens: 20,
      }),
    ].join('\n'),
  );
}

describe('token telemetry repair', () => {
  it('dry-runs, applies audited Codex corrections, and is idempotent', async () => {
    const db = createTestDb();
    insertTestProfile(db);
    seedPod(db, 'repair-pod', 'codex');
    const podRepo = createPodRepository(db);
    const attempts = createProviderAttemptRepository(db);
    openAndCloseAttempt(attempts, 'repair-pod', 'codex');
    const root = await mkdtemp(path.join(tmpdir(), 'telemetry-repair-'));
    roots.push(root);
    await writeRollout(root, 'repair-pod');
    const times = [
      new Date('2026-07-30T20:00:00.000Z'),
      new Date('2026-07-30T20:00:01.000Z'),
      new Date('2026-07-30T20:00:02.000Z'),
      new Date('2026-07-30T20:00:03.000Z'),
      new Date('2026-07-30T20:00:04.000Z'),
      new Date('2026-07-30T20:00:05.000Z'),
    ];
    const repair = createTokenTelemetryRepair({
      db,
      podRepo,
      providerAttemptRepo: attempts,
      stateRoot: root,
      now: () => times.shift() ?? new Date('2026-07-30T20:00:06.000Z'),
    });

    const dryRun = await repair.run();
    expect(dryRun).toMatchObject({
      mode: 'dry-run',
      repairedPods: 1,
      partialPods: 0,
      entries: [
        expect.objectContaining({
          podId: 'repair-pod',
          originalInputTokens: 0,
          originalOutputTokens: 0,
          originalCostUsd: 0,
        }),
      ],
    });
    expect(
      db.prepare('SELECT COUNT(*) FROM provider_attempt_telemetry_corrections').pluck().get(),
    ).toBe(0);

    const applied = await repair.run({ apply: true });
    expect(applied).toMatchObject({ mode: 'apply', repairedPods: 1 });
    expect(attempts.listRaw('repair-pod')[0]).toMatchObject({
      inputTokens: 2000,
      outputTokens: 200,
      costUsd: 2,
    });
    const expectedCost = computeCostWithCache('gpt-5', 250, 30, 140);
    expect(attempts.list('repair-pod')[0]).toMatchObject({
      inputTokens: 250,
      outputTokens: 30,
    });
    expect(attempts.list('repair-pod')[0]?.costUsd).toBeCloseTo(expectedCost);
    expect(podRepo.getOrThrow('repair-pod')).toMatchObject({
      inputTokens: 250,
      outputTokens: 30,
      tokenTelemetryAccuracy: 'repaired',
    });

    await repair.run({ apply: true });
    expect(
      db.prepare('SELECT COUNT(*) FROM provider_attempt_telemetry_corrections').pluck().get(),
    ).toBe(1);
    expect(attempts.totals('repair-pod').costUsd).toBeCloseTo(expectedCost);
  });

  it('repairs legacy Codex pods that predate provider attempts', async () => {
    const db = createTestDb();
    insertTestProfile(db);
    seedPod(db, 'legacy-codex', 'codex');
    const podRepo = createPodRepository(db);
    const attempts = createProviderAttemptRepository(db);
    const root = await mkdtemp(path.join(tmpdir(), 'telemetry-repair-legacy-'));
    roots.push(root);
    await writeRollout(root, 'legacy-codex');
    const repair = createTokenTelemetryRepair({
      db,
      podRepo,
      providerAttemptRepo: attempts,
      stateRoot: root,
    });

    const report = await repair.run({ apply: true });
    expect(report).toMatchObject({ repairedPods: 1 });
    expect(podRepo.getOrThrow('legacy-codex')).toMatchObject({
      inputTokens: 250,
      outputTokens: 30,
      tokenTelemetryAccuracy: 'repaired',
    });
  });

  it('marks missing Codex evidence and unrecoverable Claude history partial', async () => {
    const db = createTestDb();
    insertTestProfile(db);
    seedPod(db, 'missing-codex', 'codex');
    seedPod(db, 'historical-claude', 'claude');
    seedPod(db, 'already-complete', 'codex');
    const podRepo = createPodRepository(db);
    podRepo.update('already-complete', { tokenTelemetryAccuracy: 'complete' });
    const attempts = createProviderAttemptRepository(db);
    openAndCloseAttempt(attempts, 'missing-codex', 'codex');
    openAndCloseAttempt(attempts, 'historical-claude', 'claude');
    const root = await mkdtemp(path.join(tmpdir(), 'telemetry-repair-partial-'));
    roots.push(root);
    const repair = createTokenTelemetryRepair({
      db,
      podRepo,
      providerAttemptRepo: attempts,
      stateRoot: root,
    });

    const report = await repair.run();
    expect(report).toMatchObject({ partialPods: 2, skippedPods: 1 });
    expect(report.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ podId: 'missing-codex', status: 'partial' }),
        expect.objectContaining({ podId: 'already-complete', status: 'skipped' }),
        expect.objectContaining({
          podId: 'historical-claude',
          status: 'partial',
          reason: expect.stringContaining('native cost preserved'),
        }),
      ]),
    );
    expect(attempts.listRaw('historical-claude')[0]?.costUsd).toBe(2);
  });
});

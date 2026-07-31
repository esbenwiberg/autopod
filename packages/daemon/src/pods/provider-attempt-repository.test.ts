import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';

function seedPod(db: ReturnType<typeof createTestDb>, id = 'attempt-pod'): void {
  insertTestProfile(db);
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable
    ) VALUES (
      ?, 'test-profile', 'task', 'running', 'opus', 'claude', 'local', 'branch',
      'user', 3, 0, 'pr', 'auto', 'pr', 1, 0
    )
  `).run(id);
}

describe('provider attempt repository', () => {
  it('opens and closes an attempt with immutable identity, session, and accounting', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);

    const opened = repository.open({
      podId: 'attempt-pod',
      provider: 'max',
      providerAccountId: 'claude-max',
      runtime: 'claude',
      model: 'opus',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
      startedAt: '2026-07-24T10:00:00.000Z',
    });
    expect(opened).toMatchObject({ ordinal: 1, endedAt: null, inputTokens: 0 });

    expect(
      repository.updateActive('attempt-pod', {
        nativeSessionId: 'session-source',
        inputTokens: 80,
        outputTokens: 30,
        costUsd: 0.8,
      }),
    ).toMatchObject({
      nativeSessionId: 'session-source',
      inputTokens: 80,
      outputTokens: 30,
      costUsd: 0.8,
    });
    expect(() =>
      repository.updateActive('attempt-pod', {
        nativeSessionId: 'rewritten-session',
        inputTokens: 79,
        outputTokens: 30,
        costUsd: 0.8,
      }),
    ).toThrow(/append\/close-only/);
    expect(() =>
      db
        .prepare(
          `UPDATE provider_attempts
           SET ended_at = '2026-07-24T10:09:00.000Z',
               outcome = 'completed',
               input_tokens = input_tokens + 1
           WHERE pod_id = 'attempt-pod'`,
        )
        .run(),
    ).toThrow(/append\/close-only/);

    const closed = repository.close('attempt-pod', {
      nativeSessionId: null,
      endedAt: '2026-07-24T10:10:00.000Z',
      outcome: 'quota_exhausted',
      classification: {
        category: 'quota_exhausted',
        definitive: true,
        sanitizedMessage: 'Subscription limit reached',
        retryAfter: '2026-07-25T00:00:00.000Z',
      },
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 1.25,
      handoffReference: '.autopod/provider-failover.md',
    });

    expect(closed).toMatchObject({
      nativeSessionId: 'session-source',
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 1.25,
      outcome: 'quota_exhausted',
    });
    expect(repository.getActive('attempt-pod')).toBeNull();

    expect(() =>
      db
        .prepare(
          `UPDATE provider_attempts
           SET native_session_id = 'rewritten', input_tokens = 999
           WHERE pod_id = 'attempt-pod' AND ordinal = 1`,
        )
        .run(),
    ).toThrow(/append\/close-only/);
    expect(repository.list('attempt-pod')[0]?.nativeSessionId).toBe('session-source');
  });

  it('rejects duplicate active attempts and preserves stable ordinals after restart', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);
    repository.open({
      podId: 'attempt-pod',
      provider: 'max',
      providerAccountId: 'claude-max',
      runtime: 'claude',
      model: 'opus',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });

    expect(() =>
      repository.open({
        podId: 'attempt-pod',
        provider: 'openai',
        providerAccountId: 'openai-pro',
        runtime: 'codex',
        model: 'gpt-5',
        profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
        profileSnapshot: { name: 'test-profile' },
      }),
    ).toThrow(/UNIQUE constraint failed/);

    repository.close('attempt-pod', {
      nativeSessionId: 'source-session',
      outcome: 'quota_exhausted',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.75,
    });

    const restartedRepository = createProviderAttemptRepository(db);
    const target = restartedRepository.open({
      podId: 'attempt-pod',
      provider: 'openai',
      providerAccountId: 'openai-pro',
      runtime: 'codex',
      model: 'gpt-5',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });
    expect(target.ordinal).toBe(2);
    expect(restartedRepository.list('attempt-pod').map((attempt) => attempt.ordinal)).toEqual([
      1, 2,
    ]);
    expect(restartedRepository.list('attempt-pod')[0]?.nativeSessionId).toBe('source-session');
  });

  it('rejects deletion and unsafe profile references while allowing pod cascade cleanup', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);

    expect(() =>
      repository.open({
        podId: 'attempt-pod',
        provider: 'openai',
        providerAccountId: 'openai-pro',
        runtime: 'codex',
        model: 'gpt-5',
        profileReference: '{"providerCredentials":{"apiKey":"secret"}}',
        profileSnapshot: { name: 'test-profile' },
      }),
    ).toThrow(/persisted pod profile snapshot/);
    expect(() =>
      repository.open({
        podId: 'attempt-pod',
        provider: 'openai',
        providerAccountId: 'openai-pro',
        runtime: 'codex',
        model: 'gpt-5',
        profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
        profileSnapshot: { nested: { headers: { authorization: 'Bearer secret' } } },
      }),
    ).toThrow(/non-redacted sensitive field/);
    repository.open({
      podId: 'attempt-pod',
      provider: 'openai',
      providerAccountId: 'openai-pro',
      runtime: 'codex',
      model: 'gpt-5',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });
    expect(() =>
      db
        .prepare(
          `UPDATE provider_attempts
           SET handoff_reference = '.autopod/provider-failover.md'
           WHERE pod_id = 'attempt-pod'`,
        )
        .run(),
    ).toThrow(/append\/close-only/);
    repository.close('attempt-pod', {
      nativeSessionId: 'session',
      outcome: 'completed',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });

    expect(() =>
      db.prepare("DELETE FROM provider_attempts WHERE pod_id = 'attempt-pod'").run(),
    ).toThrow(/cannot be deleted directly/);
    expect(() => db.prepare("DELETE FROM pods WHERE id = 'attempt-pod'").run()).not.toThrow();
    expect(repository.list('attempt-pod')).toEqual([]);
  });

  it('keeps per-attempt accounting and returns aggregate totals', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);

    repository.open({
      podId: 'attempt-pod',
      provider: 'anthropic',
      providerAccountId: null,
      runtime: 'claude',
      model: 'opus',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });
    repository.close('attempt-pod', {
      nativeSessionId: 'claude-session',
      outcome: 'quota_exhausted',
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 1.5,
    });
    repository.open({
      podId: 'attempt-pod',
      provider: 'openai',
      providerAccountId: 'openai-pro',
      runtime: 'codex',
      model: 'gpt-5',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });
    repository.close('attempt-pod', {
      nativeSessionId: 'codex-session',
      outcome: 'completed',
      inputTokens: 60,
      outputTokens: 15,
      costUsd: 0.5,
    });

    expect(repository.list('attempt-pod').map((attempt) => attempt.costUsd)).toEqual([1.5, 0.5]);
    expect(repository.totals('attempt-pod')).toEqual({
      inputTokens: 160,
      outputTokens: 40,
      costUsd: 2,
    });
  });

  it('returns no attempts and zero totals for legacy pods', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);

    expect(repository.list('attempt-pod')).toEqual([]);
    expect(repository.totals('attempt-pod')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('projects audited telemetry corrections without rewriting raw attempts', () => {
    const db = createTestDb();
    seedPod(db);
    const repository = createProviderAttemptRepository(db);
    repository.open({
      podId: 'attempt-pod',
      provider: 'openai',
      providerAccountId: 'openai-private',
      runtime: 'codex',
      model: 'gpt-5',
      profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
      profileSnapshot: { name: 'test-profile' },
    });
    repository.close('attempt-pod', {
      nativeSessionId: 'session-1',
      outcome: 'completed',
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 2,
    });

    repository.upsertTelemetryCorrection({
      podId: 'attempt-pod',
      ordinal: 1,
      inputTokens: 400,
      outputTokens: 40,
      costUsd: 0.75,
      source: 'codex_rollout',
      reason: 'fixture reconstruction',
      correctedAt: '2026-07-30T20:00:00.000Z',
    });

    expect(repository.listRaw('attempt-pod')[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 2,
    });
    expect(repository.list('attempt-pod')[0]).toMatchObject({
      inputTokens: 400,
      outputTokens: 40,
      costUsd: 0.75,
    });
    expect(repository.totals('attempt-pod')).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      costUsd: 0.75,
    });
    expect(() =>
      db
        .prepare(
          'UPDATE provider_attempt_telemetry_corrections SET input_tokens = 1 WHERE pod_id = ?',
        )
        .run('attempt-pod'),
    ).toThrow(/append-only/);
    expect(() =>
      repository.upsertTelemetryCorrection({
        podId: 'attempt-pod',
        ordinal: 1,
        inputTokens: 401,
        outputTokens: 40,
        costUsd: 0.75,
        source: 'codex_rollout',
        reason: 'different evidence',
      }),
    ).toThrow(/Conflicting telemetry correction/);
  });

  it('reserves at most two pre-submit reviews per active attempt', () => {
    const db = createTestDb();
    seedPod(db);
    let repository = createProviderAttemptRepository(db);
    const open = () =>
      repository.open({
        podId: 'attempt-pod',
        provider: 'openai',
        providerAccountId: null,
        runtime: 'codex',
        model: 'gpt-5',
        profileReference: 'pod:attempt-pod@profile-snapshot#abcdef1',
        profileSnapshot: { name: 'test-profile' },
      });

    open();
    expect(repository.reservePreSubmitReview('attempt-pod')).toBe(true);
    repository = createProviderAttemptRepository(db);
    expect(repository.getActive('attempt-pod')?.preSubmitReviewRuns).toBe(1);
    expect(repository.reservePreSubmitReview('attempt-pod')).toBe(true);
    expect(repository.reservePreSubmitReview('attempt-pod')).toBe(false);
    expect(repository.getActive('attempt-pod')?.preSubmitReviewRuns).toBe(2);

    expect(() =>
      db
        .prepare(
          'UPDATE provider_attempts SET pre_submit_review_runs = 1 WHERE pod_id = ? AND ended_at IS NULL',
        )
        .run('attempt-pod'),
    ).toThrow(/append\/close-only/);

    repository.close('attempt-pod', {
      nativeSessionId: 'session-1',
      outcome: 'completed',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    open();
    expect(repository.getActive('attempt-pod')?.preSubmitReviewRuns).toBe(0);
    expect(repository.reservePreSubmitReview('attempt-pod')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodsitterRepository } from './podsitter-repository.js';

function setup() {
  const db = createTestDb();
  insertTestProfile(db);
  db.prepare(
    `INSERT INTO pods (
      id, profile_name, task, model, runtime, branch, user_id
    ) VALUES (
      'pod-1', 'test-profile', 'task', 'gpt-5', 'codex', 'autopod/pod-1', 'operator-1'
    )`,
  ).run();
  const accounts = createProviderAccountStore(db);
  accounts.create({ id: 'sitter-account', name: 'Sitter Account', provider: 'openai' });
  const repository = createPodsitterRepository(db);
  const actor = { type: 'human' as const, userId: 'operator-1' };
  repository.replaceConfiguration({
    enabled: true,
    activation: { mode: 'always' },
    authorizedUntil: null,
    profileScope: null,
    decisionTarget: {
      providerAccountId: 'sitter-account',
      runtime: 'codex',
      model: 'gpt-5',
    },
    updatedBy: actor,
  });
  return { db, repository, actor };
}

describe('PodsitterRepository', () => {
  it('restores pending attention and enforces durable leases', () => {
    const { db, repository } = setup();
    repository.recordAttention({
      id: 'attention-old',
      podId: 'pod-1',
      signature: 'signature-old',
      now: '2026-07-29T00:00:00.000Z',
    });
    const current = repository.recordAttention({
      id: 'attention-current',
      podId: 'pod-1',
      signature: 'signature-current',
      now: '2026-07-29T00:01:00.000Z',
    });
    repository.setProviderState(
      'sitter-account',
      {
        status: 'rate_limited',
        consecutiveFailures: 2,
        retryAt: '2026-07-29T00:10:00.000Z',
        sanitizedReason: 'provider asked the service to retry later',
      },
      '2026-07-29T00:01:00.000Z',
    );
    expect(
      repository.acquireAttentionLease(
        current.id,
        'worker-a',
        '2026-07-29T00:05:00.000Z',
        '2026-07-29T00:02:00.000Z',
      ),
    ).not.toBeNull();
    expect(
      repository.acquireProviderProbeLease(
        'sitter-account',
        'worker-a',
        '2026-07-29T00:05:00.000Z',
        '2026-07-29T00:02:00.000Z',
      ),
    ).toBe(true);

    const restored = createPodsitterRepository(db);
    expect(restored.listPendingAttention()).toEqual([
      expect.objectContaining({ id: 'attention-current', signature: 'signature-current' }),
    ]);
    expect(restored.getProviderState('sitter-account')).toMatchObject({
      status: 'rate_limited',
      consecutiveFailures: 2,
    });
    expect(
      restored.acquireAttentionLease(
        current.id,
        'worker-b',
        '2026-07-29T00:06:00.000Z',
        '2026-07-29T00:03:00.000Z',
      ),
    ).toBeNull();
    expect(
      restored.acquireProviderProbeLease(
        'sitter-account',
        'worker-b',
        '2026-07-29T00:06:00.000Z',
        '2026-07-29T00:03:00.000Z',
      ),
    ).toBe(false);
    expect(
      restored.releaseAttentionLease(
        current.id,
        'worker-a',
        'acted',
        null,
        '2026-07-29T00:06:00.000Z',
      ),
    ).toBe(false);
    expect(
      restored.acquireAttentionLease(
        current.id,
        'worker-b',
        '2026-07-29T00:10:00.000Z',
        '2026-07-29T00:06:00.000Z',
      ),
    ).toMatchObject({ leaseOwner: 'worker-b' });
    expect(
      restored.acquireProviderProbeLease(
        'sitter-account',
        'worker-b',
        '2026-07-29T00:10:00.000Z',
        '2026-07-29T00:06:00.000Z',
      ),
    ).toBe(true);

    const old = db
      .prepare("SELECT state FROM podsitter_attention WHERE id = 'attention-old'")
      .get() as { state: string };
    expect(old.state).toBe('superseded');
  });

  it('reserves each action key once', () => {
    const { repository, actor } = setup();
    const attention = repository.recordAttention({
      id: 'attention-1',
      podId: 'pod-1',
      signature: 'signature-1',
    });
    repository.acquireAttentionLease(
      attention.id,
      'decision-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:00:00Z',
    );
    repository.createDecision({
      id: 'decision-1',
      attentionId: attention.id,
      leaseOwner: 'decision-worker',
      podId: 'pod-1',
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:evidence',
      evidenceVersion: 1,
      target: {
        providerAccountId: 'sitter-account',
        runtime: 'codex',
        model: 'gpt-5',
      },
      now: '2026-07-29T00:01:00Z',
    });
    const reservation = {
      id: 'audit-1',
      idempotencyKey: 'pod-1:signature-1:approve',
      podId: 'pod-1',
      decisionId: 'decision-1',
      actor,
      action: 'approve' as const,
      arguments: {},
      policyResult: 'allowed',
    };
    expect(repository.reserveAction(reservation)).toBe(true);
    expect(repository.reserveAction({ ...reservation, id: 'audit-2' })).toBe(false);
  });

  it('normalizes lease timestamps and rejects expired leases', () => {
    const { repository } = setup();
    const attention = repository.recordAttention({
      id: 'attention-offset',
      podId: 'pod-1',
      signature: 'signature-offset',
    });
    repository.setProviderState('sitter-account', {
      status: 'available',
      consecutiveFailures: 0,
    });

    expect(
      repository.acquireAttentionLease(
        attention.id,
        'worker-a',
        '2026-07-29T02:30:00+02:00',
        '2026-07-29T00:00:00Z',
      ),
    ).toMatchObject({ leaseExpiresAt: '2026-07-29T00:30:00.000Z' });
    expect(
      repository.acquireAttentionLease(
        attention.id,
        'worker-b',
        '2026-07-29T00:45:00Z',
        '2026-07-29T00:20:00-00:00',
      ),
    ).toBeNull();
    expect(() =>
      repository.acquireAttentionLease(
        attention.id,
        'worker-b',
        '2026-07-29T00:20:00Z',
        '2026-07-29T00:20:00Z',
      ),
    ).toThrow('expiresAt must be later than now');
    expect(() =>
      repository.acquireProviderProbeLease(
        'sitter-account',
        'worker-a',
        '2026-07-29T00:19:59Z',
        '2026-07-29T00:20:00Z',
      ),
    ).toThrow('expiresAt must be later than now');
  });

  it('does not let a stale signature replay supersede newer attention', () => {
    const { repository } = setup();
    repository.recordAttention({
      id: 'attention-stale',
      podId: 'pod-1',
      signature: 'signature-stale',
      now: '2026-07-29T00:00:00Z',
    });
    repository.recordAttention({
      id: 'attention-new',
      podId: 'pod-1',
      signature: 'signature-new',
      now: '2026-07-29T00:01:00Z',
    });

    const replay = repository.recordAttention({
      id: 'ignored-replay-id',
      podId: 'pod-1',
      signature: 'signature-stale',
      now: '2026-07-29T00:02:00Z',
    });

    expect(replay).toMatchObject({ id: 'attention-stale', state: 'superseded' });
    expect(repository.listPendingAttention()).toEqual([
      expect.objectContaining({ id: 'attention-new', state: 'pending' }),
    ]);
  });

  it('enforces lease ownership and preserves provider leases across state updates', () => {
    const { repository } = setup();
    const attention = repository.recordAttention({
      id: 'attention-owned',
      podId: 'pod-1',
      signature: 'signature-owned',
    });
    repository.acquireAttentionLease(
      attention.id,
      'worker-a',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:00:00Z',
    );
    expect(
      repository.releaseAttentionLease(
        attention.id,
        'worker-b',
        'pending',
        null,
        '2026-07-29T00:30:00Z',
      ),
    ).toBe(false);
    expect(
      repository.releaseAttentionLease(
        attention.id,
        'worker-a',
        'deferred',
        null,
        '2026-07-29T00:30:00Z',
      ),
    ).toBe(true);
    expect(repository.listPendingAttention()).toEqual([
      expect.objectContaining({ id: attention.id, state: 'deferred', leaseOwner: null }),
    ]);

    repository.setProviderState('sitter-account', {
      status: 'available',
      consecutiveFailures: 0,
    });
    expect(
      repository.acquireProviderProbeLease(
        'sitter-account',
        'worker-a',
        '2026-07-29T01:00:00Z',
        '2026-07-29T00:00:00Z',
      ),
    ).toBe(true);
    repository.setProviderState(
      'sitter-account',
      {
        status: 'rate_limited',
        consecutiveFailures: 1,
        retryAt: '2026-07-29T02:30:00+02:00',
      },
      '2026-07-29T00:01:00Z',
    );
    expect(repository.getProviderState('sitter-account')).toMatchObject({
      status: 'rate_limited',
      retryAt: '2026-07-29T00:30:00.000Z',
      probeLeaseOwner: 'worker-a',
    });
    expect(repository.releaseProviderProbeLease('sitter-account', 'worker-b')).toBe(false);
    expect(repository.releaseProviderProbeLease('sitter-account', 'worker-a')).toBe(true);
  });

  it('validates decision payloads and persists action and sandbox completion', () => {
    const { db, repository, actor } = setup();
    const attention = repository.recordAttention({
      id: 'attention-lifecycle',
      podId: 'pod-1',
      signature: 'signature-lifecycle',
    });
    repository.acquireAttentionLease(
      attention.id,
      'decision-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:00:00Z',
    );
    repository.createDecision({
      id: 'decision-lifecycle',
      attentionId: attention.id,
      leaseOwner: 'decision-worker',
      podId: 'pod-1',
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:evidence',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:01:00Z',
    });
    expect(() =>
      repository.createDecision({
        id: 'decision-duplicate',
        attentionId: attention.id,
        leaseOwner: 'decision-worker',
        podId: 'pod-1',
        attentionSignature: attention.signature,
        configurationGeneration: 1,
        evidenceHash: 'sha256:duplicate',
        evidenceVersion: 1,
        target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
        now: '2026-07-29T00:02:00Z',
      }),
    ).toThrow('UNIQUE constraint failed');
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'tell' as const,
      arguments: { message: 'bounded guidance' },
      reason: 'The pod needs targeted guidance.',
      evidenceRefs: ['event:1'],
      confidence: 'high' as const,
      remainingRisk: 'The next attempt may still fail.',
      stopCondition: 'Stop after sending one message.',
    };
    expect(
      repository.completeDecision('decision-lifecycle', {
        decision,
        outcome: 'completed',
        executedAt: '2026-07-29T02:30:00+02:00',
      }),
    ).toMatchObject({
      decision,
      outcome: 'completed',
      executedAt: '2026-07-29T00:30:00.000Z',
    });
    expect(
      repository.completeDecision('decision-lifecycle', {
        decision: {
          ...decision,
          action: 'no_action',
          reason: 'A late duplicate completion must not replace the durable result.',
        },
        outcome: 'not_executed',
      }),
    ).toMatchObject({ decision, outcome: 'completed' });
    expect(() =>
      repository.completeDecision('decision-lifecycle', {
        decision: { ...decision, arguments: { accessToken: 'do-not-store' } },
        outcome: 'completed',
      }),
    ).toThrow('sensitive field');

    expect(
      repository.reserveAction({
        id: 'audit-lifecycle',
        idempotencyKey: 'action:lifecycle',
        podId: 'pod-1',
        decisionId: 'decision-lifecycle',
        actor,
        action: 'tell',
        arguments: decision.arguments,
        policyResult: 'allowed',
      }),
    ).toBe(true);
    expect(repository.completeAction('action:lifecycle', 'sent')).toBe(true);
    expect(repository.completeAction('action:lifecycle', 'sent again')).toBe(false);

    repository.createSandboxRun({
      id: 'sandbox-lifecycle',
      decisionId: 'decision-lifecycle',
      backend: 'docker',
      containerId: 'container-1',
    });
    expect(
      repository.closeSandboxRun('sandbox-lifecycle', {
        outcome: 'completed',
        cleanupState: 'cleaned',
      }),
    ).toBe(true);
    expect(
      db
        .prepare(
          'SELECT outcome, cleanup_state, completed_at FROM system_sandbox_runs WHERE id = ?',
        )
        .get('sandbox-lifecycle'),
    ).toMatchObject({
      outcome: 'completed',
      cleanup_state: 'cleaned',
      completed_at: expect.any(String),
    });
  });

  it('increments generation for every configuration replacement', () => {
    const { repository, actor } = setup();
    expect(repository.getConfiguration()?.generation).toBe(1);
    const disabled = repository.replaceConfiguration({
      enabled: false,
      activation: { mode: 'always' },
      authorizedUntil: null,
      profileScope: null,
      decisionTarget: null,
      updatedBy: actor,
    });
    expect(disabled.generation).toBe(2);
    expect(disabled.decisionTarget).toBeNull();
  });
});

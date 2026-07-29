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
    repository.createDecision({
      id: 'decision-1',
      attentionId: attention.id,
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

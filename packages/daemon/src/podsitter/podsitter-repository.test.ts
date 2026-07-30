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
    repository.initializeProviderState('sitter-account', '2026-07-29T00:00:00.000Z');
    const initialProbeVersion = repository.acquireProviderProbeLease(
      'sitter-account',
      'state-worker',
      '2026-07-29T00:00:30.000Z',
      '2026-07-29T00:00:00.000Z',
    );
    if (initialProbeVersion === null) throw new Error('Expected initial provider probe lease');
    repository.setProviderState(
      'sitter-account',
      'state-worker',
      initialProbeVersion,
      {
        status: 'rate_limited',
        consecutiveFailures: 2,
        retryAt: '2026-07-29T00:10:00.000Z',
        sanitizedReason: 'provider asked the service to retry later',
      },
      '2026-07-29T00:00:15.000Z',
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
    ).not.toBeNull();

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
        'worker-a',
        '2026-07-29T00:06:00.000Z',
        '2026-07-29T00:03:00.000Z',
      ),
    ).toBeNull();
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
        'worker-a',
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
    ).toBeNull();
    expect(
      restored.releaseAttentionLease(
        current.id,
        'worker-a',
        1,
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
    ).not.toBeNull();

    const old = db
      .prepare("SELECT state FROM podsitter_attention WHERE id = 'attention-old'")
      .get() as { state: string };
    expect(old.state).toBe('superseded');
  });

  it('fences stale decision and provider outcomes after lease recovery', () => {
    const { repository } = setup();
    const attention = repository.recordAttention({
      id: 'attention-fenced-outcome',
      podId: 'pod-1',
      signature: 'signature-fenced-outcome',
      now: '2026-07-29T00:00:00Z',
    });
    const firstLease = repository.acquireAttentionLease(
      attention.id,
      'decision-worker',
      '2026-07-29T00:05:00Z',
      '2026-07-29T00:01:00Z',
    );
    expect(firstLease?.leaseVersion).toBe(1);
    repository.createDecision({
      id: 'decision-fenced-outcome',
      attentionId: attention.id,
      leaseOwner: 'decision-worker',
      leaseVersion: 1,
      podId: attention.podId,
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:fenced-outcome',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:02:00Z',
    });
    const recoveredLease = repository.acquireAttentionLease(
      attention.id,
      'decision-worker',
      '2026-07-29T00:15:00Z',
      '2026-07-29T00:06:00Z',
    );
    expect(recoveredLease?.leaseVersion).toBe(2);
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'no_action' as const,
      arguments: {},
      reason: 'The recovered worker rebuilt current evidence.',
      evidenceRefs: ['event:fenced-outcome'],
      confidence: 'high' as const,
      remainingRisk: 'None.',
      stopCondition: 'Stop.',
    };

    expect(() =>
      repository.completeDecision(
        'decision-fenced-outcome',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          decision: { ...decision, reason: 'Stale evidence from the expired worker.' },
          outcome: 'completed',
        },
        '2026-07-29T00:07:00Z',
      ),
    ).toThrow('current attention lease');
    expect(
      repository.completeDecision(
        'decision-fenced-outcome',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 2,
          decision,
          outcome: 'completed',
        },
        '2026-07-29T00:07:00Z',
      ),
    ).toMatchObject({ decision, outcome: 'completed' });

    repository.initializeProviderState('sitter-account', '2026-07-29T00:00:00Z');
    expect(
      repository.acquireProviderProbeLease(
        'sitter-account',
        'probe-worker',
        '2026-07-29T00:05:00Z',
        '2026-07-29T00:01:00Z',
      ),
    ).toBe(1);
    expect(
      repository.acquireProviderProbeLease(
        'sitter-account',
        'probe-worker',
        '2026-07-29T00:15:00Z',
        '2026-07-29T00:06:00Z',
      ),
    ).toBe(2);
    expect(() =>
      repository.setProviderState(
        'sitter-account',
        'probe-worker',
        1,
        { status: 'available', consecutiveFailures: 0 },
        '2026-07-29T00:07:00Z',
      ),
    ).toThrow('current unexpired probe lease');
    expect(
      repository.setProviderState(
        'sitter-account',
        'probe-worker',
        2,
        {
          status: 'rate_limited',
          consecutiveFailures: 1,
          sanitizedReason: 'provider asked the service to retry later',
        },
        '2026-07-29T00:07:00Z',
      ),
    ).toMatchObject({
      status: 'rate_limited',
      consecutiveFailures: 1,
      probeLeaseOwner: 'probe-worker',
      probeLeaseVersion: 2,
    });
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
      leaseVersion: 1,
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
    repository.completeDecision(
      'decision-1',
      {
        leaseOwner: 'decision-worker',
        leaseVersion: 1,
        decision: {
          contractVersion: 1,
          attentionSignature: attention.signature,
          action: 'approve',
          arguments: {},
          reason: 'All deterministic gates passed.',
          evidenceRefs: ['readiness:1'],
          confidence: 'high',
          remainingRisk: 'Normal merge risk remains.',
          stopCondition: 'Stop after one approval.',
        },
        outcome: 'completed',
      },
      '2026-07-29T00:02:00Z',
    );
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
    expect(
      repository.reserveAction({
        ...reservation,
        id: 'audit-same-decision-new-key',
        idempotencyKey: 'pod-1:signature-1:approve:alternate',
      }),
    ).toBe(false);
    expect(
      repository.reserveAction({
        ...reservation,
        id: 'audit-wrong-pod',
        idempotencyKey: 'wrong-pod:signature-1:approve',
        podId: 'wrong-pod',
      }),
    ).toBe(false);
    expect(
      repository.reserveAction({
        ...reservation,
        id: 'audit-wrong-action',
        idempotencyKey: 'pod-1:signature-1:reject',
        action: 'reject',
        arguments: { message: 'Contradicts the completed decision.' },
      }),
    ).toBe(false);
    expect(() =>
      repository.reserveAction({
        ...reservation,
        id: 'audit-arbitrary',
        idempotencyKey: 'pod-1:signature-1:approve:arbitrary',
        arguments: { command: 'rm -rf workspace' },
      }),
    ).toThrow();
  });

  it('normalizes lease timestamps and rejects expired leases', () => {
    const { repository } = setup();
    const attention = repository.recordAttention({
      id: 'attention-offset',
      podId: 'pod-1',
      signature: 'signature-offset',
    });
    repository.initializeProviderState('sitter-account');

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
    const stale = repository.recordAttention({
      id: 'attention-stale',
      podId: 'pod-1',
      signature: 'signature-stale',
      now: '2026-07-29T00:00:00Z',
    });
    repository.acquireAttentionLease(
      stale.id,
      'stale-worker',
      '2026-07-29T00:10:00Z',
      '2026-07-29T00:00:30Z',
    );
    repository.createDecision({
      id: 'decision-stale',
      attentionId: stale.id,
      leaseOwner: 'stale-worker',
      leaseVersion: 1,
      podId: 'pod-1',
      attentionSignature: stale.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:stale',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:00:45Z',
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
    expect(repository.getDecisionForAttention(stale.id)).toMatchObject({
      id: 'decision-stale',
      outcome: 'superseded',
      completedAt: '2026-07-29T00:01:00.000Z',
    });
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
        1,
        'pending',
        null,
        '2026-07-29T00:30:00Z',
      ),
    ).toBe(false);
    expect(
      repository.releaseAttentionLease(
        attention.id,
        'worker-a',
        1,
        'deferred',
        null,
        '2026-07-29T00:30:00Z',
      ),
    ).toBe(true);
    expect(repository.listPendingAttention()).toEqual([
      expect.objectContaining({ id: attention.id, state: 'deferred', leaseOwner: null }),
    ]);

    repository.initializeProviderState('sitter-account');
    const probeVersion = repository.acquireProviderProbeLease(
      'sitter-account',
      'worker-a',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:00:00Z',
    );
    expect(probeVersion).toBe(1);
    repository.setProviderState(
      'sitter-account',
      'worker-a',
      1,
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
    expect(
      repository.releaseProviderProbeLease('sitter-account', 'worker-b', 1, '2026-07-29T00:02:00Z'),
    ).toBe(false);
    expect(
      repository.releaseProviderProbeLease('sitter-account', 'worker-a', 1, '2026-07-29T00:02:00Z'),
    ).toBe(true);
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
      leaseVersion: 1,
      podId: 'pod-1',
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:evidence',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:01:00Z',
    });
    expect(
      repository.createDecision({
        id: 'decision-duplicate',
        attentionId: attention.id,
        leaseOwner: 'decision-worker',
        leaseVersion: 1,
        podId: 'pod-1',
        attentionSignature: attention.signature,
        configurationGeneration: 1,
        evidenceHash: 'sha256:duplicate',
        evidenceVersion: 1,
        target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
        now: '2026-07-29T00:02:00Z',
      }),
    ).toMatchObject({ id: 'decision-lifecycle' });
    expect(repository.getDecisionForAttention(attention.id)).toMatchObject({
      id: 'decision-lifecycle',
    });
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'dismiss_validation_finding' as const,
      arguments: {
        reason: 'The finding is deterministically stale.',
        findingId: 'finding-1',
      },
      reason: 'The pod needs targeted guidance.',
      evidenceRefs: ['event:1'],
      confidence: 'high' as const,
      remainingRisk: 'The next attempt may still fail.',
      stopCondition: 'Stop after sending one message.',
    };
    expect(() =>
      repository.completeDecision(
        'decision-lifecycle',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          outcome: 'completed',
        },
        '2026-07-29T00:10:00Z',
      ),
    ).toThrow('requires a decision payload');
    expect(() =>
      repository.completeDecision(
        'decision-lifecycle',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          decision: {
            ...decision,
            attentionSignature: 'signature-from-unrelated-evidence',
          },
          outcome: 'completed',
        },
        '2026-07-29T00:10:00Z',
      ),
    ).toThrow('attention signature does not match');
    expect(repository.getDecisionForAttention(attention.id)).toMatchObject({
      outcome: 'pending',
      decision: null,
    });
    expect(
      repository.completeDecision(
        'decision-lifecycle',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          decision,
          outcome: 'completed',
          executedAt: '2026-07-29T02:30:00+02:00',
        },
        '2026-07-29T00:30:00Z',
      ),
    ).toMatchObject({
      decision,
      outcome: 'completed',
      executedAt: '2026-07-29T00:30:00.000Z',
    });
    expect(
      repository.completeDecision(
        'decision-lifecycle',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          decision: {
            ...decision,
            action: 'no_action',
            arguments: {},
            reason: 'A late duplicate completion must not replace the durable result.',
          },
          outcome: 'not_executed',
        },
        '2026-07-29T00:31:00Z',
      ),
    ).toMatchObject({ decision, outcome: 'completed' });
    expect(() =>
      repository.completeDecision(
        'decision-lifecycle',
        {
          leaseOwner: 'decision-worker',
          leaseVersion: 1,
          decision: { ...decision, arguments: { accessToken: 'do-not-store' } },
          outcome: 'completed',
        },
        '2026-07-29T00:32:00Z',
      ),
    ).toThrow();

    expect(
      repository.reserveAction({
        id: 'audit-lifecycle',
        idempotencyKey: 'action:lifecycle',
        podId: 'pod-1',
        decisionId: 'decision-lifecycle',
        actor,
        action: 'dismiss_validation_finding',
        arguments: {
          findingId: 'finding-1',
          reason: 'The finding is deterministically stale.',
        },
        policyResult: 'allowed',
      }),
    ).toBe(true);
    expect(
      repository.reserveAction({
        id: 'audit-mismatched-arguments',
        idempotencyKey: 'action:lifecycle:mismatched-arguments',
        podId: 'pod-1',
        decisionId: 'decision-lifecycle',
        actor,
        action: 'dismiss_validation_finding',
        arguments: {
          findingId: 'finding-1',
          reason: 'A materially different justification.',
        },
        policyResult: 'allowed',
      }),
    ).toBe(false);
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
      repository.closeSandboxRun('sandbox-lifecycle', {
        outcome: 'failed',
        cleanupState: 'leaked',
        failureCode: 'late-overwrite',
      }),
    ).toBe(false);
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

    expect(() => db.prepare("DELETE FROM pods WHERE id = 'pod-1'").run()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM podsitter_attention').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM podsitter_decisions').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM podsitter_action_audit').get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare('SELECT decision_id FROM system_sandbox_runs WHERE id = ?')
        .get('sandbox-lifecycle'),
    ).toEqual({ decision_id: null });
  });

  it('recovers a linked decision after a crash and rejects mismatched attention identity', () => {
    const { db, repository } = setup();
    const attention = repository.recordAttention({
      id: 'attention-crash',
      podId: 'pod-1',
      signature: 'signature-crash',
    });
    repository.acquireAttentionLease(
      attention.id,
      'worker-before-crash',
      '2026-07-29T00:05:00Z',
      '2026-07-29T00:00:00Z',
    );

    const input = {
      id: 'decision-before-crash',
      attentionId: attention.id,
      leaseOwner: 'worker-before-crash',
      leaseVersion: 1,
      podId: 'pod-1',
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:crash-evidence',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex' as const, model: 'gpt-5' },
      now: '2026-07-29T00:01:00Z',
    };
    repository.createDecision(input);
    expect(
      db.prepare('SELECT decision_id FROM podsitter_attention WHERE id = ?').get(attention.id),
    ).toEqual({ decision_id: 'decision-before-crash' });

    const restored = createPodsitterRepository(db);
    restored.acquireAttentionLease(
      attention.id,
      'worker-after-crash',
      '2026-07-29T00:15:00Z',
      '2026-07-29T00:06:00Z',
    );
    expect(
      restored.createDecision({
        ...input,
        id: 'decision-after-crash',
        leaseOwner: 'worker-after-crash',
        leaseVersion: 2,
        now: '2026-07-29T00:07:00Z',
      }),
    ).toMatchObject({ id: 'decision-before-crash' });

    expect(() =>
      restored.createDecision({
        ...input,
        id: 'decision-wrong-signature',
        leaseOwner: 'worker-after-crash',
        leaseVersion: 2,
        attentionSignature: 'wrong-signature',
        now: '2026-07-29T00:08:00Z',
      }),
    ).toThrow('matching current unexpired attention lease');
    expect(() =>
      restored.createDecision({
        ...input,
        id: 'decision-wrong-pod',
        leaseOwner: 'worker-after-crash',
        leaseVersion: 2,
        podId: 'wrong-pod',
        now: '2026-07-29T00:08:00Z',
      }),
    ).toThrow('active configuration authority');
  });

  it('rejects decisions after configuration replacement or disablement', () => {
    const { repository, actor } = setup();
    const attention = repository.recordAttention({
      id: 'attention-config-race',
      podId: 'pod-1',
      signature: 'signature-config-race',
    });
    repository.acquireAttentionLease(
      attention.id,
      'config-race-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:00:00Z',
    );
    const replaced = repository.replaceConfiguration(
      {
        enabled: true,
        activation: { mode: 'always' },
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5.1',
        },
        updatedBy: actor,
      },
      '2026-07-29T00:01:00Z',
    );
    const input = {
      id: 'decision-config-race',
      attentionId: attention.id,
      leaseOwner: 'config-race-worker',
      leaseVersion: 1,
      podId: 'pod-1',
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:config-race',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex' as const, model: 'gpt-5' },
      now: '2026-07-29T00:02:00Z',
    };

    expect(() => repository.createDecision(input)).toThrow('active configuration authority');
    expect(() =>
      repository.createDecision({
        ...input,
        configurationGeneration: replaced.generation,
        target: { ...input.target, model: 'arbitrary-model' },
      }),
    ).toThrow('active configuration authority');

    const disabled = repository.replaceConfiguration(
      {
        enabled: false,
        activation: replaced.activation,
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: replaced.decisionTarget,
        updatedBy: actor,
      },
      '2026-07-29T00:03:00Z',
    );
    expect(() =>
      repository.createDecision({
        ...input,
        configurationGeneration: disabled.generation,
        target: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5.1',
        },
        now: '2026-07-29T00:04:00Z',
      }),
    ).toThrow('active configuration authority');
  });

  it('rejects decisions for pods outside the configured profile scope', () => {
    const { db, repository, actor } = setup();
    insertTestProfile(db, { name: 'out-of-scope-profile' });
    db.prepare(
      `INSERT INTO pods (
        id, profile_name, task, model, runtime, branch, user_id
      ) VALUES (
        'pod-out-of-scope', 'out-of-scope-profile', 'task', 'gpt-5', 'codex',
        'autopod/pod-out-of-scope', 'operator-1'
      )`,
    ).run();
    const configuration = repository.replaceConfiguration(
      {
        enabled: true,
        activation: { mode: 'always' },
        authorizedUntil: null,
        profileScope: ['test-profile'],
        decisionTarget: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5',
        },
        updatedBy: actor,
      },
      '2026-07-29T00:00:00Z',
    );
    const attention = repository.recordAttention({
      id: 'attention-out-of-scope',
      podId: 'pod-out-of-scope',
      signature: 'signature-out-of-scope',
      now: '2026-07-29T00:00:00Z',
    });
    repository.acquireAttentionLease(
      attention.id,
      'scope-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:01:00Z',
    );

    expect(() =>
      repository.createDecision({
        id: 'decision-out-of-scope',
        attentionId: attention.id,
        leaseOwner: 'scope-worker',
        leaseVersion: 1,
        podId: attention.podId,
        attentionSignature: attention.signature,
        configurationGeneration: configuration.generation,
        evidenceHash: 'sha256:out-of-scope',
        evidenceVersion: 1,
        target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
        now: '2026-07-29T00:02:00Z',
      }),
    ).toThrow('active configuration authority');
  });

  it('retains but cannot execute decisions after configuration authority is revoked', () => {
    const { repository, actor } = setup();
    const attention = repository.recordAttention({
      id: 'attention-revoked',
      podId: 'pod-1',
      signature: 'signature-revoked',
      now: '2026-07-29T00:00:00Z',
    });
    repository.acquireAttentionLease(
      attention.id,
      'revoked-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:01:00Z',
    );
    repository.createDecision({
      id: 'decision-revoked',
      attentionId: attention.id,
      leaseOwner: 'revoked-worker',
      leaseVersion: 1,
      podId: attention.podId,
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:revoked',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:02:00Z',
    });
    repository.replaceConfiguration(
      {
        enabled: false,
        activation: { mode: 'always' },
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5',
        },
        updatedBy: actor,
      },
      '2026-07-29T00:03:00Z',
    );
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'no_action' as const,
      arguments: {},
      reason: 'No intervention is warranted.',
      evidenceRefs: ['event:revoked'],
      confidence: 'high' as const,
      remainingRisk: 'None.',
      stopCondition: 'Stop.',
    };

    expect(
      repository.completeDecision(
        'decision-revoked',
        {
          leaseOwner: 'revoked-worker',
          leaseVersion: 1,
          decision,
          outcome: 'completed',
          executedAt: '2026-07-29T00:04:00Z',
        },
        '2026-07-29T00:04:00Z',
      ),
    ).toMatchObject({
      decision,
      outcome: 'not_executed',
      failureCode: 'authorization_revoked',
      executedAt: null,
    });
    expect(
      repository.reserveAction({
        id: 'audit-revoked',
        idempotencyKey: 'action:revoked',
        podId: 'pod-1',
        decisionId: 'decision-revoked',
        actor,
        action: 'no_action',
        arguments: {},
        policyResult: 'allowed',
        now: '2026-07-29T00:05:00Z',
      }),
    ).toBe(false);
  });

  it('rejects action reservation after the decision configuration generation changes', () => {
    const { repository, actor } = setup();
    const attention = repository.recordAttention({
      id: 'attention-stale-action',
      podId: 'pod-1',
      signature: 'signature-stale-action',
      now: '2026-07-29T00:00:00Z',
    });
    repository.acquireAttentionLease(
      attention.id,
      'stale-action-worker',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:01:00Z',
    );
    repository.createDecision({
      id: 'decision-stale-action',
      attentionId: attention.id,
      leaseOwner: 'stale-action-worker',
      leaseVersion: 1,
      podId: attention.podId,
      attentionSignature: attention.signature,
      configurationGeneration: 1,
      evidenceHash: 'sha256:stale-action',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:02:00Z',
    });
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'no_action' as const,
      arguments: {},
      reason: 'No intervention is warranted.',
      evidenceRefs: ['event:stale-action'],
      confidence: 'high' as const,
      remainingRisk: 'None.',
      stopCondition: 'Stop.',
    };
    repository.completeDecision(
      'decision-stale-action',
      {
        leaseOwner: 'stale-action-worker',
        leaseVersion: 1,
        decision,
        outcome: 'completed',
      },
      '2026-07-29T00:03:00Z',
    );
    repository.replaceConfiguration(
      {
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
      },
      '2026-07-29T00:04:00Z',
    );

    expect(
      repository.reserveAction({
        id: 'audit-stale-generation',
        idempotencyKey: 'action:stale-generation',
        podId: 'pod-1',
        decisionId: 'decision-stale-action',
        actor,
        action: 'no_action',
        arguments: {},
        policyResult: 'allowed',
        now: '2026-07-29T00:05:00Z',
      }),
    ).toBe(false);
  });

  it('does not carry decision authority into a later recurring window', () => {
    const { repository, actor } = setup();
    const configuration = repository.replaceConfiguration(
      {
        enabled: true,
        activation: {
          mode: 'recurring',
          cronExpression: '0 0 * * *',
          durationMinutes: 60,
          timeZone: 'UTC',
        },
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5',
        },
        updatedBy: actor,
      },
      '2026-07-29T00:00:00Z',
    );
    const attention = repository.recordAttention({
      id: 'attention-recurring-window',
      podId: 'pod-1',
      signature: 'signature-recurring-window',
      now: '2026-07-29T00:05:00Z',
    });
    repository.acquireAttentionLease(
      attention.id,
      'recurring-worker',
      '2026-07-29T00:30:00Z',
      '2026-07-29T00:05:00Z',
    );
    const created = repository.createDecision({
      id: 'decision-recurring-window',
      attentionId: attention.id,
      leaseOwner: 'recurring-worker',
      leaseVersion: 1,
      podId: attention.podId,
      attentionSignature: attention.signature,
      configurationGeneration: configuration.generation,
      evidenceHash: 'sha256:recurring-window',
      evidenceVersion: 1,
      target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
      now: '2026-07-29T00:10:00Z',
    });
    const decision = {
      contractVersion: 1 as const,
      attentionSignature: attention.signature,
      action: 'no_action' as const,
      arguments: {},
      reason: 'No intervention is warranted.',
      evidenceRefs: ['event:recurring-window'],
      confidence: 'high' as const,
      remainingRisk: 'None.',
      stopCondition: 'Stop.',
    };

    expect(created.activationWindowId).toBe(
      `recurring:g${configuration.generation}:2026-07-29T00:00:00.000Z`,
    );
    expect(() =>
      repository.completeDecision(
        created.id,
        {
          leaseOwner: 'recurring-worker',
          leaseVersion: 1,
          decision,
          outcome: 'completed',
        },
        '2026-07-30T00:10:00Z',
      ),
    ).toThrow('current attention lease');
  });

  it('enforces decision and action ceilings transactionally per activation window', () => {
    const { db, repository, actor } = setup();
    db.prepare(
      `INSERT INTO pods (
        id, profile_name, task, model, runtime, branch, user_id
      ) VALUES (
        'pod-2', 'test-profile', 'task', 'gpt-5', 'codex', 'autopod/pod-2', 'operator-1'
      )`,
    ).run();
    const configuration = repository.replaceConfiguration(
      {
        enabled: true,
        activation: { mode: 'always' },
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: {
          providerAccountId: 'sitter-account',
          runtime: 'codex',
          model: 'gpt-5',
        },
        budgets: { maxDecisionsPerWindow: 2, maxActionsPerWindow: 1 },
        updatedBy: actor,
      },
      '2026-07-29T00:00:00Z',
    );
    const completedDecisionIds: string[] = [];
    for (const [suffix, podId] of [
      ['one', 'pod-1'],
      ['two', 'pod-2'],
    ] as const) {
      const attention = repository.recordAttention({
        id: `attention-budget-${suffix}`,
        podId,
        signature: `signature-budget-${suffix}`,
        now: '2026-07-29T00:01:00Z',
      });
      repository.acquireAttentionLease(
        attention.id,
        `budget-worker-${suffix}`,
        '2026-07-29T01:00:00Z',
        '2026-07-29T00:02:00Z',
      );
      const created = repository.createDecision({
        id: `decision-budget-${suffix}`,
        attentionId: attention.id,
        leaseOwner: `budget-worker-${suffix}`,
        leaseVersion: 1,
        podId: attention.podId,
        attentionSignature: attention.signature,
        configurationGeneration: configuration.generation,
        evidenceHash: `sha256:budget-${suffix}`,
        evidenceVersion: 1,
        target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
        now: '2026-07-29T00:03:00Z',
      });
      repository.completeDecision(
        created.id,
        {
          leaseOwner: `budget-worker-${suffix}`,
          leaseVersion: 1,
          decision: {
            contractVersion: 1,
            attentionSignature: attention.signature,
            action: 'no_action',
            arguments: {},
            reason: 'No intervention is warranted.',
            evidenceRefs: [`event:budget-${suffix}`],
            confidence: 'high',
            remainingRisk: 'None.',
            stopCondition: 'Stop.',
          },
          outcome: 'completed',
        },
        '2026-07-29T00:04:00Z',
      );
      completedDecisionIds.push(created.id);
    }

    const reserve = (index: number, podId: string) =>
      repository.reserveAction({
        id: `audit-budget-${index}`,
        idempotencyKey: `action:budget-${index}`,
        podId,
        decisionId: completedDecisionIds[index] ?? '',
        actor,
        action: 'no_action',
        arguments: {},
        policyResult: 'allowed',
        now: '2026-07-29T00:05:00Z',
      });
    expect(reserve(0, 'pod-1')).toBe(true);
    expect(reserve(1, 'pod-2')).toBe(false);

    const excessAttention = repository.recordAttention({
      id: 'attention-budget-excess',
      podId: 'pod-1',
      signature: 'signature-budget-excess',
      now: '2026-07-29T00:06:00Z',
    });
    repository.acquireAttentionLease(
      excessAttention.id,
      'budget-worker-excess',
      '2026-07-29T01:00:00Z',
      '2026-07-29T00:06:00Z',
    );
    expect(() =>
      repository.createDecision({
        id: 'decision-budget-excess',
        attentionId: excessAttention.id,
        leaseOwner: 'budget-worker-excess',
        leaseVersion: 1,
        podId: excessAttention.podId,
        attentionSignature: excessAttention.signature,
        configurationGeneration: configuration.generation,
        evidenceHash: 'sha256:budget-excess',
        evidenceVersion: 1,
        target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
        now: '2026-07-29T00:07:00Z',
      }),
    ).toThrow('budget is exhausted');
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

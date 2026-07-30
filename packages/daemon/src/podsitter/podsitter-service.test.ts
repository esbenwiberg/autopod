import type { Pod, PodsitterDecision } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../pods/event-bus.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { buildPodsitterEvidence } from './evidence-builder.js';
import { createPodsitterRepository } from './podsitter-repository.js';
import { createPodsitterService } from './podsitter-service.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');

function setup() {
  const db = createTestDb();
  insertTestProfile(db);
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id, status)
     VALUES ('pod-1', 'test-profile', 'task', 'gpt-5', 'codex', 'branch', 'operator', 'failed')`,
  ).run();
  createProviderAccountStore(db).create({
    id: 'sitter-account',
    name: 'Sitter',
    provider: 'openai',
  });
  const repository = createPodsitterRepository(db);
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
      updatedBy: { type: 'human', userId: 'operator' },
    },
    NOW.toISOString(),
  );
  let evidenceRevision = 1;
  let deterministicApproval = false;
  const candidate = () => ({
    pod: {
      id: 'pod-1',
      profileName: 'test-profile',
      status: 'failed',
    } as Pod,
    signature: 'attention-current',
    failureSignature: 'failure-current',
    evidence: buildPodsitterEvidence({
      podId: 'pod-1',
      generatedAt: NOW.toISOString(),
      sources: [{ ref: 'pod:state', value: { revision: evidenceRevision } }],
    }),
    deterministicApproval,
  });
  const evidenceProvider = {
    listCandidates: vi.fn(async () => [candidate()]),
    getCandidate: vi.fn(async () => candidate()),
  };
  const eventBus = createEventBus(createEventRepository(db), logger);
  const execute = vi.fn(async () => ({ outcome: 'executed' as const, detail: 'done' }));
  const decision = (): PodsitterDecision => ({
    contractVersion: 1,
    attentionSignature: 'attention-current',
    action: 'report',
    arguments: { message: 'Operator should inspect the failure' },
    reason: 'Current evidence is conclusive',
    evidenceRefs: ['pod:state'],
    confidence: 'high',
    remainingRisk: 'The underlying failure remains',
    stopCondition: 'Operator receives the report',
  });
  return {
    db,
    repository,
    eventBus,
    evidenceProvider,
    execute,
    decision,
    setEvidenceRevision(value: number) {
      evidenceRevision = value;
    },
    setDeterministicApproval(value: boolean) {
      deterministicApproval = value;
    },
  };
}

function service(
  harness: ReturnType<typeof setup>,
  run: ReturnType<typeof vi.fn>,
  options: {
    now?: () => Date;
    probeProvider?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return createPodsitterService({
    repository: harness.repository,
    evidenceProvider: harness.evidenceProvider,
    decisionRunner: { run },
    actionExecutor: { execute: harness.execute },
    eventBus: harness.eventBus,
    logger,
    executionTarget: 'local',
    now: options.now ?? (() => NOW),
    probeProvider: options.probeProvider,
    sweepIntervalMs: 60 * 60_000,
  });
}

describe('PodsitterService', () => {
  it('executes one current authorized decision', async () => {
    const harness = setup();
    const run = vi.fn(async () => ({
      ok: true as const,
      decision: harness.decision(),
      telemetry: {},
      cleanup: 'clean' as const,
    }));
    const sitter = service(harness, run);

    await sitter.reconcile();
    await sitter.reconcile();

    expect(run).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.repository.listDecisions().items[0]).toMatchObject({
      evidenceHash: expect.any(String),
      outcome: 'completed',
      decision: { evidenceRefs: ['pod:state'] },
    });
  });

  it('recovers durable work without duplicate actions', async () => {
    const harness = setup();
    const run = vi.fn(async () => ({
      ok: true as const,
      decision: harness.decision(),
      telemetry: {},
      cleanup: 'clean' as const,
    }));
    await service(harness, run).reconcile();
    const reconstructed = service(harness, run);
    await reconstructed.start();
    await reconstructed.stop();

    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.repository.listPendingAttention()).toHaveLength(0);
  });

  it('backs off provider limits without consuming action attempts', async () => {
    const harness = setup();
    const run = vi.fn(async () => ({
      ok: false as const,
      kind: 'provider' as const,
      failure: {
        category: 'quota_exhausted' as const,
        definitive: true,
        sanitizedMessage: 'usage limit reached',
        retryAfter: null,
      },
      cleanup: 'clean' as const,
    }));
    const sitter = service(harness, run);

    await sitter.reconcile();
    harness.setDeterministicApproval(true);
    await sitter.reconcile();

    expect(run).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.execute.mock.calls[0]?.[0].decision.action).toBe('approve');
    expect(harness.repository.getProviderState('sitter-account')).toMatchObject({
      status: 'quota_exhausted',
      consecutiveFailures: 1,
    });
    expect(harness.repository.listPendingAttention()).toHaveLength(0);
  });

  it('rebuilds evidence after provider recovery', async () => {
    const harness = setup();
    let clock = NOW;
    const limited = {
      ok: false as const,
      kind: 'provider' as const,
      failure: {
        category: 'transient' as const,
        definitive: false,
        sanitizedMessage: 'rate limited',
        retryAfter: null,
      },
      cleanup: 'clean' as const,
    };
    const run = vi.fn().mockResolvedValueOnce(limited).mockResolvedValue({
      ok: true,
      decision: harness.decision(),
      telemetry: {},
      cleanup: 'clean',
    });
    const probe = vi.fn(async () => ({
      ok: true as const,
      decision: harness.decision(),
      telemetry: {},
      cleanup: 'clean' as const,
    }));
    const sitter = service(harness, run, { now: () => clock, probeProvider: probe });
    await sitter.reconcile();
    const firstHash = harness.repository.listDecisions().items[0]?.evidenceHash;

    harness.setEvidenceRevision(2);
    clock = new Date(NOW.getTime() + 2 * 60_000);
    await sitter.probe();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(harness.repository.getProviderState('sitter-account')).toMatchObject({
      status: 'available',
    });
    expect(harness.repository.listPendingAttention()).toEqual([]);
    expect(harness.evidenceProvider.getCandidate).toHaveBeenCalledTimes(3);
    expect(harness.repository.listDecisions().items[0]?.evidenceHash).not.toBe(firstHash);
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute after disable expiry or generation change', async () => {
    const harness = setup();
    const run = vi.fn(async () => {
      const current = harness.repository.getConfiguration();
      if (!current) throw new Error('missing configuration');
      harness.repository.replaceConfiguration(
        {
          enabled: false,
          activation: current.activation,
          authorizedUntil: current.authorizedUntil,
          profileScope: current.profileScope,
          decisionTarget: current.decisionTarget,
          budgets: current.budgets,
          updatedBy: { type: 'human', userId: 'operator' },
        },
        NOW.toISOString(),
      );
      return {
        ok: true as const,
        decision: harness.decision(),
        telemetry: {},
        cleanup: 'clean' as const,
      };
    });

    await service(harness, run).reconcile();

    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.repository.listDecisions().items[0]?.outcome).toBe('not_executed');
  });
});

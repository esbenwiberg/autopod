import {
  PODSITTER_ACTIONS,
  type Pod,
  type PodsitterAction,
  type PodsitterActionArguments,
  type PodsitterDecision,
} from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PodManager } from '../pods/pod-manager.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { PodsitterActionExecutor } from './action-executor.js';
import { type PodsitterRepository, createPodsitterRepository } from './podsitter-repository.js';

const actor = {
  type: 'podsitter' as const,
  decisionId: 'decision-1',
  providerAccountId: 'account-1',
  model: 'gpt-5',
};

const argumentsByAction: PodsitterActionArguments = {
  no_action: {},
  report: { message: 'Needs operator review' },
  approve: {},
  reject: { message: 'Please revise' },
  tell: { message: 'Continue with the smallest fix' },
  nudge: { message: 'Please report progress' },
  dismiss_validation_finding: { findingId: 'finding-1', reason: 'Known false positive' },
  guide_validation_fix: { findingId: 'finding-1', guidance: 'Fix the failing assertion' },
  extend_budget: {},
  kick: {},
  interrupt_validation: {},
  revalidate: {},
  extend_validation_attempts: {},
  approve_fact_waiver: { factId: 'fact-1', justification: 'Toolchain unavailable' },
  extend_pr_attempts: {},
  spawn_fix: {},
  retry_pr: {},
  update_from_base: {},
  inject_credential: { credentialId: 'github' },
  install_tool: { toolName: 'gh' },
  recover_worktree: {},
  force_approve: { failedPhases: ['facts'], manualEvidenceRefs: ['validation:1'] },
  skip_validation: { failedPhases: ['tests'], manualEvidenceRefs: ['validation:1'] },
  force_complete: { failedPhases: ['push'], manualEvidenceRefs: ['event:1'] },
  fix_manually: { instructions: 'Repair the branch manually' },
};

const statusByAction: Partial<Record<PodsitterAction, Pod['status']>> = {
  approve: 'validated',
  reject: 'validated',
  tell: 'awaiting_input',
  nudge: 'running',
  dismiss_validation_finding: 'review_required',
  guide_validation_fix: 'awaiting_input',
  extend_budget: 'awaiting_input',
  kick: 'running',
  interrupt_validation: 'validating',
  revalidate: 'failed',
  extend_validation_attempts: 'review_required',
  approve_fact_waiver: 'review_required',
  extend_pr_attempts: 'failed',
  spawn_fix: 'merge_pending',
  retry_pr: 'complete',
  update_from_base: 'failed',
  inject_credential: 'running',
  install_tool: 'running',
  recover_worktree: 'failed',
  force_approve: 'failed',
  skip_validation: 'failed',
  force_complete: 'failed',
  fix_manually: 'validated',
};

const operationByAction: Record<PodsitterAction, string | null> = {
  no_action: null,
  report: 'report',
  approve: 'approveSession',
  reject: 'rejectSession',
  tell: 'sendMessage',
  nudge: 'nudgeSession',
  dismiss_validation_finding: 'dismissValidationFinding',
  guide_validation_fix: 'sendMessage',
  extend_budget: 'sendMessage',
  kick: 'kickPod',
  interrupt_validation: 'interruptValidation',
  revalidate: 'revalidateSession',
  extend_validation_attempts: 'extendAttempts',
  approve_fact_waiver: 'approveFactWaiver',
  extend_pr_attempts: 'extendPrAttempts',
  spawn_fix: 'spawnFixSession',
  retry_pr: 'retryCreatePr',
  update_from_base: 'updateFromBase',
  inject_credential: 'injectCredential',
  install_tool: 'installCliTool',
  recover_worktree: 'recoverWorktree',
  force_approve: 'forceApprove',
  skip_validation: 'setSkipValidation',
  force_complete: 'forceComplete',
  fix_manually: 'fixManually',
};

function decision<Action extends PodsitterAction>(
  action: Action,
  overrides: Partial<PodsitterDecision> = {},
): PodsitterDecision {
  return {
    contractVersion: 1,
    attentionSignature: 'signature-1',
    action,
    arguments: argumentsByAction[action],
    reason: 'Evidence supports this intervention',
    evidenceRefs: ['pod:state', 'validation:1', 'event:1'],
    confidence: 'high',
    remainingRisk: 'Operator should review the final result',
    stopCondition: 'Stop after this one action',
    ...overrides,
  } as PodsitterDecision;
}

function harness(reserved = true) {
  const calls: string[] = [];
  const currentPod = {
    id: 'pod-1',
    status: 'failed',
    worktreeCompromised: true,
    failureReason: 'Push failed',
    lastValidationResult: {
      setup: { status: 'pass' },
      lint: { status: 'pass' },
      sast: { status: 'pass' },
      smoke: {
        build: { status: 'pass' },
        health: { status: 'pass' },
        pages: [],
      },
      test: { status: 'fail' },
      factValidation: { status: 'fail' },
      taskReview: { status: 'pass' },
    },
  } as Pod;
  const manager = new Proxy(
    {
      getSession: vi.fn(() => currentPod),
    } as unknown as PodManager,
    {
      get(target, property, receiver) {
        if (Reflect.has(target as object, property)) return Reflect.get(target as object, property);
        return (..._args: unknown[]) => {
          calls.push(String(property));
          if (property === 'revalidateSession' || property === 'approveFactWaiver') {
            return Promise.resolve({ newCommits: false, result: 'pass' });
          }
          return Promise.resolve();
        };
      },
    },
  );
  const repository = {
    reserveAction: vi.fn(() => reserved),
    completeAction: vi.fn(() => true),
  } as unknown as PodsitterRepository;
  const operations = {
    dismissValidationFinding: vi.fn(() => calls.push('dismissValidationFinding')),
    report: vi.fn(() => calls.push('report')),
  };
  return {
    calls,
    manager,
    repository,
    operations,
    executor: new PodsitterActionExecutor(repository, manager, operations),
  };
}

function durableHarness() {
  const db = createTestDb();
  insertTestProfile(db);
  db.prepare(
    `INSERT INTO pods (
      id, profile_name, task, model, runtime, branch, user_id, status, failure_reason
    ) VALUES (
      'pod-1', 'test-profile', 'task', 'gpt-5', 'codex', 'autopod/pod-1',
      'operator-1', 'running', 'stuck'
    )`,
  ).run();
  createProviderAccountStore(db).create({
    id: 'sitter-account',
    name: 'Sitter Account',
    provider: 'openai',
  });
  const repository = createPodsitterRepository(db);
  const configuration = repository.replaceConfiguration({
    enabled: true,
    activation: { mode: 'always' },
    authorizedUntil: null,
    profileScope: null,
    decisionTarget: {
      providerAccountId: 'sitter-account',
      runtime: 'codex',
      model: 'gpt-5',
    },
    updatedBy: { type: 'human', userId: 'operator-1' },
  });
  const sideEffect = vi.fn();
  const manager = {
    getSession: vi.fn(
      () =>
        ({
          id: 'pod-1',
          status: 'running',
          failureReason: 'stuck',
          worktreeCompromised: false,
        }) as Pod,
    ),
    kickPod: sideEffect,
  } as unknown as PodManager;
  const executor = new PodsitterActionExecutor(repository, manager, {
    dismissValidationFinding: vi.fn(),
    report: vi.fn(),
  });
  return { db, repository, configuration, manager, executor, sideEffect };
}

function persistDecision(
  repository: PodsitterRepository,
  input: {
    id: string;
    attentionId: string;
    signature: string;
    failureSignature: string;
    generation: number;
    action?: PodsitterAction;
    overrides?: Partial<PodsitterDecision>;
  },
) {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + 60_000).toISOString();
  const attention = repository.recordAttention({
    id: input.attentionId,
    podId: 'pod-1',
    signature: input.signature,
    failureSignature: input.failureSignature,
    now: now.toISOString(),
  });
  const lease = repository.acquireAttentionLease(
    attention.id,
    `worker-${input.id}`,
    leaseExpiry,
    now.toISOString(),
  );
  if (!lease) throw new Error('Expected attention lease');
  repository.createDecision({
    id: input.id,
    attentionId: attention.id,
    leaseOwner: `worker-${input.id}`,
    leaseVersion: lease.leaseVersion,
    podId: 'pod-1',
    attentionSignature: input.signature,
    configurationGeneration: input.generation,
    evidenceHash: `sha256:${input.id}`,
    evidenceVersion: 1,
    target: { providerAccountId: 'sitter-account', runtime: 'codex', model: 'gpt-5' },
    now: now.toISOString(),
  });
  const persisted = decision(input.action ?? 'kick', {
    attentionSignature: input.signature,
    ...input.overrides,
  } as Partial<PodsitterDecision>);
  repository.completeDecision(
    input.id,
    {
      leaseOwner: `worker-${input.id}`,
      leaseVersion: lease.leaseVersion,
      decision: persisted,
      outcome: 'completed',
    },
    now.toISOString(),
  );
  return persisted;
}

describe('PodsitterActionExecutor', () => {
  it('maps the full Podsitter action contract', async () => {
    const seen = new Set<PodsitterAction>();
    for (const action of PODSITTER_ACTIONS) {
      const h = harness();
      vi.mocked(h.manager.getSession).mockReturnValue({
        ...h.manager.getSession('pod-1'),
        status: statusByAction[action] ?? 'failed',
      } as Pod);

      const result = await h.executor.execute({
        podId: 'pod-1',
        decision: decision(action),
        actor,
        activationGeneration: 7,
        windowId: 'always:7',
      });

      expect(result.outcome, action).toBe('executed');
      expect(h.calls, action).toEqual(
        operationByAction[action] === null ? [] : [operationByAction[action]],
      );
      expect(h.repository.reserveAction, action).toHaveBeenCalledOnce();
      expect(h.repository.completeAction, action).toHaveBeenCalledOnce();
      seen.add(action);
    }
    expect([...seen]).toEqual([...PODSITTER_ACTIONS]);

    const invalidManualFix = harness();
    vi.mocked(invalidManualFix.manager.getSession).mockReturnValue({
      ...invalidManualFix.manager.getSession('pod-1'),
      status: 'merge_pending',
    } as Pod);
    await expect(
      invalidManualFix.executor.execute({
        podId: 'pod-1',
        decision: decision('fix_manually'),
        actor,
        activationGeneration: 7,
        windowId: 'always:7',
      }),
    ).resolves.toMatchObject({ outcome: 'not_executed' });
    expect(invalidManualFix.calls).toEqual([]);

    const h = harness();
    await expect(
      h.executor.execute({
        podId: 'pod-1',
        decision: decision('force_complete', {
          evidenceRefs: [],
          remainingRisk: '',
        } as Partial<PodsitterDecision>),
        actor,
        activationGeneration: 7,
        windowId: 'always:7',
      }),
    ).rejects.toMatchObject({ code: 'PODSITTER_EVIDENCE_REQUIRED' });
    expect(h.repository.reserveAction).not.toHaveBeenCalled();
  });

  it('rejects stale and duplicate decisions before side effects', async () => {
    const stale = durableHarness();
    const staleDecision = persistDecision(stale.repository, {
      id: 'decision-stale',
      attentionId: 'attention-stale',
      signature: 'signature-stale',
      failureSignature: 'failure-stale',
      generation: stale.configuration.generation,
    });
    stale.repository.recordAttention({
      id: 'attention-current',
      podId: 'pod-1',
      signature: 'signature-current',
      failureSignature: 'failure-current',
    });
    await expect(
      stale.executor.execute({
        podId: 'pod-1',
        decision: staleDecision,
        actor: {
          ...actor,
          decisionId: 'decision-stale',
          providerAccountId: 'sitter-account',
        },
        activationGeneration: stale.configuration.generation,
        windowId: `always:g${stale.configuration.generation}`,
        failureSignature: 'failure-stale',
      }),
    ).resolves.toMatchObject({ outcome: 'superseded' });
    expect(stale.sideEffect).not.toHaveBeenCalled();

    const duplicate = durableHarness();
    const first = persistDecision(duplicate.repository, {
      id: 'decision-first',
      attentionId: 'attention-first',
      signature: 'signature-first',
      failureSignature: 'failure-repeat',
      generation: duplicate.configuration.generation,
    });
    await expect(
      duplicate.executor.execute({
        podId: 'pod-1',
        decision: first,
        actor: {
          ...actor,
          decisionId: 'decision-first',
          providerAccountId: 'sitter-account',
        },
        activationGeneration: duplicate.configuration.generation,
        windowId: `always:g${duplicate.configuration.generation}`,
        failureSignature: 'failure-repeat',
      }),
    ).resolves.toMatchObject({ outcome: 'executed' });
    const second = persistDecision(duplicate.repository, {
      id: 'decision-second',
      attentionId: 'attention-second',
      signature: 'signature-second',
      failureSignature: 'failure-repeat',
      generation: duplicate.configuration.generation,
    });
    await expect(
      duplicate.executor.execute({
        podId: 'pod-1',
        decision: second,
        actor: {
          ...actor,
          decisionId: 'decision-second',
          providerAccountId: 'sitter-account',
        },
        activationGeneration: duplicate.configuration.generation,
        windowId: `always:g${duplicate.configuration.generation}`,
        failureSignature: 'failure-repeat',
      }),
    ).resolves.toMatchObject({ outcome: 'superseded' });
    expect(duplicate.sideEffect).toHaveBeenCalledTimes(1);

    const mismatchedActor = durableHarness();
    const actorDecision = persistDecision(mismatchedActor.repository, {
      id: 'decision-actor',
      attentionId: 'attention-actor',
      signature: 'signature-actor',
      failureSignature: 'failure-actor',
      generation: mismatchedActor.configuration.generation,
    });
    await expect(
      mismatchedActor.executor.execute({
        podId: 'pod-1',
        decision: actorDecision,
        actor: {
          ...actor,
          decisionId: 'decision-actor',
          providerAccountId: 'sitter-account',
          model: 'different-model',
        },
        activationGeneration: mismatchedActor.configuration.generation,
        windowId: `always:g${mismatchedActor.configuration.generation}`,
        failureSignature: 'failure-actor',
      }),
    ).resolves.toMatchObject({ outcome: 'superseded' });
    expect(mismatchedActor.sideEffect).not.toHaveBeenCalled();

    for (const budgetAction of [
      'extend_budget',
      'extend_validation_attempts',
      'extend_pr_attempts',
      'kick',
      'recover_worktree',
      'force_approve',
      'skip_validation',
      'force_complete',
    ] as const) {
      const budget = durableHarness();
      const firstBudgetDecision = persistDecision(budget.repository, {
        id: `decision-${budgetAction}-first`,
        attentionId: `attention-${budgetAction}-first`,
        signature: `signature-${budgetAction}-first`,
        failureSignature: `failure-${budgetAction}`,
        generation: budget.configuration.generation,
        action: budgetAction,
      });
      const reserve = (
        decisionId: string,
        signature: string,
        failureSignature: string,
        actionDecision: PodsitterDecision,
      ) =>
        budget.repository.reserveAction({
          id: `audit-${decisionId}`,
          idempotencyKey: `action:${decisionId}`,
          podId: 'pod-1',
          decisionId,
          attentionSignature: signature,
          activationGeneration: budget.configuration.generation,
          activationWindowId: `always:g${budget.configuration.generation}`,
          failureSignature,
          actor: {
            type: 'podsitter',
            decisionId,
            providerAccountId: 'sitter-account',
            model: 'gpt-5',
          },
          action: budgetAction,
          arguments: actionDecision.arguments,
          policyResult: 'allowed',
        });
      expect(
        reserve(
          `decision-${budgetAction}-first`,
          `signature-${budgetAction}-first`,
          `failure-${budgetAction}`,
          firstBudgetDecision,
        ),
        budgetAction,
      ).toBe(true);

      const repeatedFailure =
        budgetAction === 'force_approve' ||
        budgetAction === 'skip_validation' ||
        budgetAction === 'force_complete'
          ? `new-failure-${budgetAction}`
          : `failure-${budgetAction}`;
      const secondBudgetDecision = persistDecision(budget.repository, {
        id: `decision-${budgetAction}-second`,
        attentionId: `attention-${budgetAction}-second`,
        signature: `signature-${budgetAction}-second`,
        failureSignature: repeatedFailure,
        generation: budget.configuration.generation,
        action: budgetAction,
      });
      expect(
        reserve(
          `decision-${budgetAction}-second`,
          `signature-${budgetAction}-second`,
          repeatedFailure,
          secondBudgetDecision,
        ),
        budgetAction,
      ).toBe(false);
    }
  });

  it('has no open-ended action path', async () => {
    const h = harness();
    const base = decision('tell');
    for (const unsafe of [
      { ...base, action: 'execute_command', arguments: { command: 'rm -rf /' } },
      { ...base, arguments: { message: 'hello', url: 'https://example.test' } },
      { ...base, arguments: { message: 'hello', path: '/workspace' } },
    ]) {
      await expect(
        h.executor.execute({
          podId: 'pod-1',
          decision: unsafe as PodsitterDecision,
          actor,
          activationGeneration: 7,
          windowId: 'always:7',
        }),
      ).rejects.toThrow();
    }
    expect(h.repository.reserveAction).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);

    const secretAudit = durableHarness();
    const secretDecision = persistDecision(secretAudit.repository, {
      id: 'decision-secret-audit',
      attentionId: 'attention-secret-audit',
      signature: 'signature-secret-audit',
      failureSignature: 'failure-secret-audit',
      generation: secretAudit.configuration.generation,
      action: 'tell',
      overrides: {
        arguments: {
          message: 'Use token sk-abcdefghijklmnopqrstuvwx for the next step',
        },
      } as Partial<PodsitterDecision>,
    });
    expect(
      secretAudit.repository.reserveAction({
        id: 'audit-secret',
        idempotencyKey: 'action:secret',
        podId: 'pod-1',
        decisionId: 'decision-secret-audit',
        attentionSignature: 'signature-secret-audit',
        activationGeneration: secretAudit.configuration.generation,
        activationWindowId: `always:g${secretAudit.configuration.generation}`,
        failureSignature: 'failure-secret-audit',
        actor: {
          type: 'podsitter',
          decisionId: 'decision-secret-audit',
          providerAccountId: 'sitter-account',
          model: 'gpt-5',
        },
        action: 'tell',
        arguments: secretDecision.arguments,
        policyResult: 'allowed',
      }),
    ).toBe(true);
    const audit = secretAudit.db
      .prepare("SELECT arguments FROM podsitter_action_audit WHERE id = 'audit-secret'")
      .get() as { arguments: string };
    expect(audit.arguments).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(audit.arguments).toContain('[API_KEY_REDACTED]');
  });
});

import {
  PODSITTER_ACTIONS,
  type Pod,
  type PodsitterAction,
  type PodsitterActionArguments,
  type PodsitterDecision,
} from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PodManager } from '../pods/pod-manager.js';
import { PodsitterActionExecutor } from './action-executor.js';
import type { PodsitterRepository } from './podsitter-repository.js';

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
  fix_manually: 'failed',
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
    for (const staleCase of ['generation', 'signature', 'state', 'duplicate']) {
      const h = harness(false);
      const result = await h.executor.execute({
        podId: 'pod-1',
        decision: decision('force_complete'),
        actor,
        activationGeneration: staleCase === 'generation' ? 6 : 7,
        windowId: 'always:7',
      });
      expect(result.outcome, staleCase).toBe('superseded');
      expect(h.calls, staleCase).toEqual([]);
      expect(h.repository.completeAction, staleCase).not.toHaveBeenCalled();
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
  });
});

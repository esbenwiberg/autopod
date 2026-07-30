import { createHash } from 'node:crypto';
import {
  AutopodError,
  type OperatorActor,
  type Pod,
  type PodsitterAction,
  type PodsitterDecision,
  operatorActorSchema,
  podsitterDecisionSchema,
} from '@autopod/shared';
import type { PodManager } from '../pods/pod-manager.js';
import type { PodsitterRepository } from './podsitter-repository.js';

const LAST_RESORT_ACTIONS = new Set<PodsitterAction>([
  'recover_worktree',
  'force_approve',
  'skip_validation',
  'force_complete',
]);

const ALLOWED_STATUSES: Partial<Record<PodsitterAction, readonly Pod['status'][]>> = {
  approve: ['validated'],
  reject: ['validated', 'review_required'],
  tell: ['running', 'awaiting_input', 'paused'],
  nudge: ['running', 'awaiting_input', 'paused'],
  dismiss_validation_finding: ['running', 'validating', 'failed', 'review_required'],
  guide_validation_fix: ['running', 'awaiting_input', 'failed', 'review_required'],
  extend_budget: ['awaiting_input'],
  kick: ['queued', 'provisioning', 'running', 'validating'],
  interrupt_validation: ['validating'],
  revalidate: ['failed', 'review_required'],
  extend_validation_attempts: ['review_required'],
  approve_fact_waiver: ['running', 'validating', 'failed', 'review_required'],
  extend_pr_attempts: ['failed', 'merge_pending'],
  spawn_fix: ['merge_pending'],
  retry_pr: ['complete'],
  update_from_base: ['validating', 'failed', 'review_required'],
  inject_credential: ['running', 'awaiting_input', 'paused'],
  install_tool: ['running', 'awaiting_input', 'paused'],
  recover_worktree: ['failed', 'review_required', 'paused'],
  force_approve: ['failed', 'review_required', 'awaiting_input'],
  skip_validation: ['failed', 'review_required', 'awaiting_input', 'validating'],
  force_complete: ['failed'],
  fix_manually: ['failed', 'review_required', 'merge_pending'],
};

export interface PodsitterActionOperations {
  dismissValidationFinding(podId: string, findingId: string, reason: string): Promise<void> | void;
  report(podId: string, message: string, actor: OperatorActor): Promise<void> | void;
}

export interface ExecutePodsitterActionInput {
  podId: string;
  decision: PodsitterDecision;
  actor: OperatorActor;
  activationGeneration: number;
  windowId: string;
  failureSignature?: string | null;
}

export interface PodsitterActionExecutionResult {
  outcome: 'executed' | 'not_executed' | 'superseded' | 'duplicate';
  detail: string;
}

function idempotencyKey(input: ExecutePodsitterActionInput): string {
  return `podsitter:${input.actor.type === 'podsitter' ? input.actor.decisionId : 'invalid'}:${input.decision.attentionSignature}`;
}

function auditId(key: string): string {
  return `psa-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function assertActionStatus(action: PodsitterAction, pod: Pod): void {
  const allowed = ALLOWED_STATUSES[action];
  if (allowed && !allowed.includes(pod.status)) {
    throw new AutopodError(
      `Podsitter action ${action} is not allowed for pod ${pod.id} in status ${pod.status}`,
      'INVALID_STATE',
      409,
    );
  }
}

function assertLastResortEvidence(decision: PodsitterDecision): void {
  if (!LAST_RESORT_ACTIONS.has(decision.action)) return;
  if (
    !decision.reason.trim() ||
    decision.evidenceRefs.length === 0 ||
    !decision.remainingRisk.trim()
  ) {
    throw new AutopodError(
      `${decision.action} requires a reason, evidence references, and remaining risk`,
      'PODSITTER_EVIDENCE_REQUIRED',
      400,
    );
  }
}

export class PodsitterActionExecutor {
  constructor(
    private readonly repository: PodsitterRepository,
    private readonly podManager: PodManager,
    private readonly operations: PodsitterActionOperations,
  ) {}

  async execute(input: ExecutePodsitterActionInput): Promise<PodsitterActionExecutionResult> {
    const actor = operatorActorSchema.parse(input.actor);
    if (actor.type !== 'podsitter' || actor.decisionId.trim().length === 0) {
      throw new AutopodError(
        'Podsitter executor requires a Podsitter actor with a decision id',
        'INVALID_ACTOR',
        400,
      );
    }
    const decision = podsitterDecisionSchema.parse(input.decision) as PodsitterDecision;
    assertLastResortEvidence(decision);

    // Re-read policy-relevant pod state before consuming the durable reservation.
    this.podManager.getSession(input.podId);

    const key = idempotencyKey({ ...input, actor, decision });
    const reserved = this.repository.reserveAction({
      id: auditId(key),
      idempotencyKey: key,
      podId: input.podId,
      decisionId: actor.decisionId,
      attentionSignature: decision.attentionSignature,
      activationGeneration: input.activationGeneration,
      activationWindowId: input.windowId,
      failureSignature: input.failureSignature,
      actor,
      action: decision.action,
      arguments: decision.arguments,
      policyResult: 'allowed',
    });
    if (!reserved) {
      return {
        outcome: 'superseded',
        detail:
          'Current activation, signature, decision, or reservation no longer authorizes action',
      };
    }

    try {
      // Re-read after the transactional reservation so lifecycle races still
      // become audited not_executed outcomes before any operational call.
      assertActionStatus(decision.action, this.podManager.getSession(input.podId));
      await this.dispatch(input.podId, decision, actor);
      this.repository.completeAction(key, 'executed');
      return { outcome: 'executed', detail: 'Action executed' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const auditCode =
        error instanceof AutopodError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'UNKNOWN_ERROR';
      this.repository.completeAction(key, `not_executed:${auditCode}`);
      return { outcome: 'not_executed', detail };
    }
  }

  private async dispatch(
    podId: string,
    decision: PodsitterDecision,
    actor: Extract<OperatorActor, { type: 'podsitter' }>,
  ): Promise<void> {
    switch (decision.action) {
      case 'no_action':
        return;
      case 'report':
        await this.operations.report(podId, decision.arguments.message, actor);
        return;
      case 'approve':
        await this.podManager.approveSession(podId, { actor, reason: decision.reason });
        return;
      case 'reject':
        await this.podManager.rejectSession(podId, decision.arguments.message, actor);
        return;
      case 'tell':
        await this.podManager.sendMessage(podId, decision.arguments.message, actor);
        return;
      case 'nudge':
        this.podManager.nudgeSession(podId, decision.arguments.message);
        return;
      case 'dismiss_validation_finding':
        await this.operations.dismissValidationFinding(
          podId,
          decision.arguments.findingId,
          decision.arguments.reason,
        );
        return;
      case 'guide_validation_fix':
        await this.podManager.sendMessage(podId, decision.arguments.guidance, actor);
        return;
      case 'extend_budget':
        await this.podManager.sendMessage(podId, 'approved', actor);
        return;
      case 'kick':
        await this.podManager.kickPod(podId, decision.reason, actor);
        return;
      case 'interrupt_validation':
        this.podManager.interruptValidation(podId);
        return;
      case 'revalidate':
        await this.podManager.revalidateSession(podId, { force: true });
        return;
      case 'extend_validation_attempts':
        await this.podManager.extendAttempts(podId, 1);
        return;
      case 'approve_fact_waiver':
        await this.podManager.approveFactWaiver(
          podId,
          decision.arguments.factId,
          decision.arguments.justification,
          actor,
        );
        return;
      case 'extend_pr_attempts':
        await this.podManager.extendPrAttempts(podId, 1);
        return;
      case 'spawn_fix':
        await this.podManager.spawnFixSession(podId);
        return;
      case 'retry_pr':
        await this.podManager.retryCreatePr(podId);
        return;
      case 'update_from_base':
        await this.podManager.updateFromBase(podId);
        return;
      case 'inject_credential':
        if (
          decision.arguments.credentialId !== 'github' &&
          decision.arguments.credentialId !== 'ado'
        ) {
          throw new AutopodError('Unsupported credential id', 'INVALID_ARGUMENTS', 400);
        }
        await this.podManager.injectCredential(podId, decision.arguments.credentialId);
        return;
      case 'install_tool':
        if (decision.arguments.toolName !== 'gh' && decision.arguments.toolName !== 'az') {
          throw new AutopodError('Unsupported tool name', 'INVALID_ARGUMENTS', 400);
        }
        await this.podManager.installCliTool(podId, decision.arguments.toolName);
        return;
      case 'recover_worktree':
        await this.podManager.recoverWorktree(podId);
        return;
      case 'force_approve':
        await this.podManager.forceApprove(podId, decision.reason, actor);
        return;
      case 'skip_validation':
        this.podManager.setSkipValidation(podId, true, actor);
        return;
      case 'force_complete':
        await this.podManager.forceComplete(podId, decision.reason, actor);
        return;
      case 'fix_manually':
        this.podManager.fixManually(podId, `podsitter:${actor.decisionId}`);
        return;
    }
  }
}

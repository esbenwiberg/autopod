import { randomUUID } from 'node:crypto';
import type {
  Pod,
  PodsitterAttention,
  PodsitterConfiguration,
  PodsitterProviderCircuitStatus,
  SystemEvent,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventBus } from '../pods/event-bus.js';
import type {
  SystemDecisionRunResult,
  SystemDecisionRunner,
} from '../system-sandbox/system-decision-runner.js';
import type { PodsitterActionExecutor } from './action-executor.js';
import { evaluatePodsitterActivation } from './activation.js';
import { type PodsitterEvidencePacket, buildPodsitterDecisionPrompt } from './evidence-builder.js';
import type { PodsitterRepository } from './podsitter-repository.js';

const DEFAULT_SWEEP_MS = 60_000;
const LEASE_MS = 15 * 60_000;
const PROVIDER_BACKOFF: Record<Exclude<PodsitterProviderCircuitStatus, 'available'>, number[]> = {
  rate_limited: [60_000, 300_000, 900_000, 1_800_000],
  quota_exhausted: [300_000, 900_000, 1_800_000, 3_600_000],
  auth_failed: [1_800_000],
  unavailable: [60_000, 300_000, 900_000, 1_800_000],
};

export interface PodsitterCandidate {
  pod: Pod;
  signature: string;
  failureSignature?: string | null;
  evidence: PodsitterEvidencePacket;
  deterministicApproval?: boolean;
}

export interface PodsitterEvidenceProvider {
  listCandidates(
    now: Date,
    configuration: PodsitterConfiguration | null,
  ): Promise<PodsitterCandidate[]>;
  getCandidate(
    podId: string,
    now: Date,
    configuration: PodsitterConfiguration,
  ): Promise<PodsitterCandidate | null>;
}

export interface PodsitterService {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(options?: { readOnly?: boolean }): Promise<{ queued: number; processed: number }>;
  probe(): Promise<boolean>;
  status(): {
    configuration: PodsitterConfiguration | null;
    activation: ReturnType<typeof evaluatePodsitterActivation> | null;
    provider: ReturnType<PodsitterRepository['getProviderState']> | null;
    queueCount: number;
  };
}

export interface PodsitterServiceDependencies {
  repository: PodsitterRepository;
  evidenceProvider: PodsitterEvidenceProvider;
  decisionRunner: Pick<SystemDecisionRunner, 'run'>;
  actionExecutor: Pick<PodsitterActionExecutor, 'execute'>;
  eventBus: EventBus;
  logger: Logger;
  executionTarget: 'local' | 'sandbox';
  now?: () => Date;
  sweepIntervalMs?: number;
  probeProvider?: (configuration: PodsitterConfiguration) => Promise<SystemDecisionRunResult>;
  reapLeakedSandboxes?: () => Promise<number>;
}

function attentionId(podId: string, signature: string): string {
  return `psat-${podId}-${signature.slice(0, 20)}`;
}

function providerStatus(result: Extract<SystemDecisionRunResult, { ok: false }>) {
  switch (result.failure.category) {
    case 'quota_exhausted':
      return 'quota_exhausted' as const;
    case 'auth':
      return 'auth_failed' as const;
    case 'transient':
      return 'rate_limited' as const;
    default:
      return 'unavailable' as const;
  }
}

function retryAt(
  status: Exclude<PodsitterProviderCircuitStatus, 'available'>,
  failures: number,
  providerRetryAfter: string | null,
  now: Date,
): string {
  if (providerRetryAfter) {
    const seconds = Number(providerRetryAfter);
    const parsed = Number.isFinite(seconds)
      ? now.getTime() + seconds * 1000
      : Date.parse(providerRetryAfter);
    if (Number.isFinite(parsed) && parsed > now.getTime()) return new Date(parsed).toISOString();
  }
  const schedule = PROVIDER_BACKOFF[status];
  return new Date(
    now.getTime() + (schedule[Math.min(failures - 1, schedule.length - 1)] ?? 60_000),
  ).toISOString();
}

function relevantEvent(event: SystemEvent): boolean {
  return (
    'podId' in event &&
    (event.type.startsWith('pod.') ||
      event.type.startsWith('validation.') ||
      event.type.startsWith('readiness.'))
  );
}

export function createPodsitterService(deps: PodsitterServiceDependencies): PodsitterService {
  const now = deps.now ?? (() => new Date());
  const owner = `podsitter-${randomUUID()}`;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let chain = Promise.resolve();
  let stopped = true;
  let activationObservation: string | null = null;

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work, work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  function emit(event: SystemEvent): void {
    deps.eventBus.emit(event);
  }

  async function recordCandidates(configuration: PodsitterConfiguration | null): Promise<number> {
    const candidates = await deps.evidenceProvider.listCandidates(now(), configuration);
    for (const candidate of candidates) {
      const existing = deps.repository.recordAttention({
        id: attentionId(candidate.pod.id, candidate.signature),
        podId: candidate.pod.id,
        signature: candidate.signature,
        failureSignature: candidate.failureSignature,
        now: now().toISOString(),
      });
      if (existing.firstSeenAt === existing.lastSeenAt) {
        emit({
          type: 'podsitter.attention_queued',
          timestamp: now().toISOString(),
          podId: candidate.pod.id,
          attentionId: existing.id,
          attentionSignature: existing.signature,
        });
      }
    }
    return candidates.length;
  }

  async function limitProvider(
    configuration: PodsitterConfiguration,
    result: Extract<SystemDecisionRunResult, { ok: false }>,
    leaseVersion: number,
  ): Promise<void> {
    const current =
      deps.repository.getProviderState(configuration.decisionTarget?.providerAccountId ?? '') ??
      undefined;
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const status = providerStatus(result);
    const accountId = configuration.decisionTarget?.providerAccountId;
    if (!accountId) return;
    const nextRetry = retryAt(status, failures, result.failure.retryAfter, now());
    deps.repository.setProviderState(
      accountId,
      owner,
      leaseVersion,
      {
        status,
        consecutiveFailures: failures,
        retryAt: nextRetry,
        resetAt: status === 'quota_exhausted' ? nextRetry : null,
        sanitizedReason: result.failure.sanitizedMessage,
      },
      now().toISOString(),
    );
    emit({
      type: 'podsitter.provider_limited',
      timestamp: now().toISOString(),
      providerAccountId: accountId,
      status,
      retryAt: nextRetry,
    });
  }

  async function processAttention(
    attention: PodsitterAttention,
    configuration: PodsitterConfiguration,
  ): Promise<boolean> {
    const target = configuration.decisionTarget;
    if (!target) return false;
    const activation = evaluatePodsitterActivation(configuration, now());
    if (!activation.active || !activation.windowId) return false;
    const lease = deps.repository.acquireAttentionLease(
      attention.id,
      owner,
      new Date(now().getTime() + LEASE_MS).toISOString(),
      now().toISOString(),
    );
    if (!lease) return false;
    const candidate = await deps.evidenceProvider.getCandidate(
      attention.podId,
      now(),
      configuration,
    );
    if (!candidate || candidate.signature !== attention.signature) {
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'superseded',
        lease.decisionId,
        now().toISOString(),
      );
      return false;
    }

    const provider = deps.repository.getProviderState(target.providerAccountId);
    if (provider && provider.status !== 'available' && !candidate.deterministicApproval) {
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'deferred',
        lease.decisionId,
        now().toISOString(),
      );
      return false;
    }

    const priorDecision = deps.repository.getDecisionForAttention(lease.id);
    const evidenceReferencesAreCurrent = (references: string[]): boolean => {
      const available = new Set(candidate.evidence.evidenceRefs);
      return references.every((reference) => available.has(reference));
    };
    const executeCompletedDecision = async (
      decisionId: string,
      decision: NonNullable<typeof priorDecision>['decision'],
    ): Promise<boolean> => {
      if (!decision || !evidenceReferencesAreCurrent(decision.evidenceRefs)) {
        deps.repository.releaseAttentionLease(
          lease.id,
          owner,
          lease.leaseVersion,
          'superseded',
          decisionId,
          now().toISOString(),
        );
        return false;
      }
      const actor = {
        type: 'podsitter' as const,
        decisionId,
        providerAccountId: target.providerAccountId,
        model: target.model,
      };
      const execution =
        decision.action === 'no_action'
          ? { outcome: 'not_executed' as const, detail: 'Model selected no_action' }
          : await deps.actionExecutor.execute({
              podId: candidate.pod.id,
              decision,
              actor,
              activationGeneration: configuration.generation,
              windowId: activation.windowId,
              failureSignature: candidate.failureSignature,
            });
      const executed = execution.outcome === 'executed';
      if (executed) deps.repository.markDecisionExecuted(decisionId, now().toISOString());
      const attentionState = executed
        ? decision.action === 'report'
          ? 'reported'
          : 'acted'
        : execution.outcome === 'outcome_unknown'
          ? 'failed'
          : 'superseded';
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        attentionState,
        decisionId,
        now().toISOString(),
      );
      if (decision.action !== 'no_action') {
        emit({
          type: executed ? 'podsitter.action_executed' : 'podsitter.action_rejected',
          timestamp: now().toISOString(),
          podId: candidate.pod.id,
          decisionId,
          action: decision.action,
          ...(executed ? { actor } : { policyResult: execution.detail }),
        } as SystemEvent);
      }
      return executed;
    };
    if (priorDecision?.outcome === 'completed') {
      return executeCompletedDecision(priorDecision.id, priorDecision.decision);
    }
    if (
      priorDecision &&
      priorDecision.outcome !== 'failed' &&
      priorDecision.outcome !== 'pending'
    ) {
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'superseded',
        priorDecision.id,
        now().toISOString(),
      );
      return false;
    }
    const record = priorDecision
      ? deps.repository.refreshDecisionForRetry({
          attentionId: lease.id,
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          configurationGeneration: configuration.generation,
          evidenceHash: candidate.evidence.hash,
          evidenceVersion: candidate.evidence.version,
          target,
          now: now().toISOString(),
        })
      : deps.repository.createDecision({
          id: `psd-${randomUUID()}`,
          attentionId: lease.id,
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          podId: candidate.pod.id,
          attentionSignature: candidate.signature,
          configurationGeneration: configuration.generation,
          evidenceHash: candidate.evidence.hash,
          evidenceVersion: candidate.evidence.version,
          target,
          now: now().toISOString(),
        });
    const decisionId = record.id;
    emit({
      type: 'podsitter.decision_started',
      timestamp: now().toISOString(),
      podId: candidate.pod.id,
      decisionId,
      attentionSignature: candidate.signature,
      providerAccountId: target.providerAccountId,
      model: target.model,
    });

    if (provider && provider.status !== 'available' && candidate.deterministicApproval) {
      const decision = {
        contractVersion: 1 as const,
        attentionSignature: candidate.signature,
        action: 'approve' as const,
        arguments: {},
        reason:
          'Strict deterministic readiness: ready review, passing validation, sound worktree, and no blocker or escalation',
        evidenceRefs: candidate.evidence.evidenceRefs,
        confidence: 'high' as const,
        remainingRisk: '',
        stopCondition: 'Pod leaves validated state',
      };
      deps.repository.completeDecision(
        record.id,
        {
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          decision,
          outcome: 'completed',
        },
        now().toISOString(),
      );
      emit({
        type: 'podsitter.decision_completed',
        timestamp: now().toISOString(),
        podId: candidate.pod.id,
        decisionId,
        action: decision.action,
        outcome: 'completed',
        evidenceRefs: decision.evidenceRefs,
      });
      return executeCompletedDecision(record.id, decision);
    }

    deps.repository.initializeProviderState(target.providerAccountId, now().toISOString());
    const probeLease = deps.repository.acquireProviderProbeLease(
      target.providerAccountId,
      owner,
      new Date(now().getTime() + LEASE_MS).toISOString(),
      now().toISOString(),
    );
    if (probeLease === null) {
      deps.repository.completeDecision(
        record.id,
        {
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          outcome: 'failed',
          failureCode: 'provider_probe_busy',
        },
        now().toISOString(),
      );
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'deferred',
        record.id,
        now().toISOString(),
      );
      return false;
    }
    const result = await deps.decisionRunner.run({
      decisionId,
      providerAccountId: target.providerAccountId,
      runtime: target.runtime,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
      prompt: buildPodsitterDecisionPrompt(candidate.evidence),
      contractVersion: 1,
      executionTarget: deps.executionTarget,
      timeoutMs: LEASE_MS - 5_000,
    });
    if (!result.ok) {
      await limitProvider(configuration, result, probeLease);
      deps.repository.releaseProviderProbeLease(
        target.providerAccountId,
        owner,
        probeLease,
        now().toISOString(),
      );
      deps.repository.completeDecision(
        record.id,
        {
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          outcome: 'failed',
          failureCode: result.failure.code ?? result.failure.category,
        },
        now().toISOString(),
      );
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'deferred',
        record.id,
        now().toISOString(),
      );
      return false;
    }
    deps.repository.releaseProviderProbeLease(
      target.providerAccountId,
      owner,
      probeLease,
      now().toISOString(),
    );
    const refreshedConfiguration = deps.repository.getConfiguration();
    const refreshed = refreshedConfiguration
      ? await deps.evidenceProvider.getCandidate(candidate.pod.id, now(), refreshedConfiguration)
      : null;
    const stillAuthorized =
      refreshedConfiguration?.generation === configuration.generation &&
      refreshed?.signature === candidate.signature &&
      evaluatePodsitterActivation(refreshedConfiguration, now()).active;
    if (!stillAuthorized || result.decision.attentionSignature !== candidate.signature) {
      deps.repository.completeDecision(
        record.id,
        {
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          decision: result.decision,
          outcome: 'superseded',
          ...result.telemetry,
        },
        now().toISOString(),
      );
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'superseded',
        record.id,
        now().toISOString(),
      );
      return false;
    }
    if (!evidenceReferencesAreCurrent(result.decision.evidenceRefs)) {
      deps.repository.completeDecision(
        record.id,
        {
          leaseOwner: owner,
          leaseVersion: lease.leaseVersion,
          decision: result.decision,
          outcome: 'failed',
          failureCode: 'unknown_evidence_reference',
          ...result.telemetry,
        },
        now().toISOString(),
      );
      deps.repository.releaseAttentionLease(
        lease.id,
        owner,
        lease.leaseVersion,
        'failed',
        record.id,
        now().toISOString(),
      );
      emit({
        type: 'podsitter.action_rejected',
        timestamp: now().toISOString(),
        podId: candidate.pod.id,
        decisionId,
        action: result.decision.action,
        policyResult: 'unknown_evidence_reference',
      });
      return false;
    }
    deps.repository.completeDecision(
      record.id,
      {
        leaseOwner: owner,
        leaseVersion: lease.leaseVersion,
        decision: result.decision,
        outcome: 'completed',
        ...result.telemetry,
      },
      now().toISOString(),
    );
    emit({
      type: 'podsitter.decision_completed',
      timestamp: now().toISOString(),
      podId: candidate.pod.id,
      decisionId,
      action: result.decision.action,
      outcome: 'completed',
      evidenceRefs: result.decision.evidenceRefs,
    });
    return executeCompletedDecision(record.id, result.decision);
  }

  async function reconcileInternal(options: { readOnly?: boolean } = {}) {
    const configuration = deps.repository.getConfiguration();
    const queued = await recordCandidates(configuration);
    if (options.readOnly || !configuration) return { queued, processed: 0 };
    const activation = evaluatePodsitterActivation(configuration, now());
    const observation = `${configuration.generation}:${activation.reason}:${activation.windowId ?? ''}`;
    if (activation.reason === 'expired' && activationObservation !== observation) {
      emit({
        type: 'podsitter.activation_changed',
        timestamp: now().toISOString(),
        enabled: configuration.enabled,
        active: false,
        reason: 'expired',
        generation: configuration.generation,
        actor: { type: 'automation', id: 'podsitter-authorization-expiry' },
      });
    }
    activationObservation = observation;
    if (!activation.active) return { queued, processed: 0 };
    const target = configuration.decisionTarget;
    const provider = target ? deps.repository.getProviderState(target.providerAccountId) : null;
    if (
      provider?.status !== 'available' &&
      provider?.retryAt &&
      Date.parse(provider.retryAt) <= now().getTime() &&
      deps.probeProvider
    ) {
      await probeInternal();
    }
    let processed = 0;
    for (const attention of deps.repository.listPendingAttention()) {
      try {
        if (await processAttention(attention, configuration)) processed += 1;
      } catch (error) {
        deps.logger.warn({ err: error, podId: attention.podId }, 'Podsitter attention failed');
      }
    }
    return { queued, processed };
  }

  async function probeInternal(): Promise<boolean> {
    const configuration = deps.repository.getConfiguration();
    const target = configuration?.decisionTarget;
    if (!configuration || !target || !deps.probeProvider) return false;
    deps.repository.initializeProviderState(target.providerAccountId, now().toISOString());
    const leaseVersion = deps.repository.acquireProviderProbeLease(
      target.providerAccountId,
      owner,
      new Date(now().getTime() + LEASE_MS).toISOString(),
      now().toISOString(),
    );
    if (leaseVersion === null) return false;
    const result = await deps.probeProvider(configuration);
    if (!result.ok) {
      await limitProvider(configuration, result, leaseVersion);
      deps.repository.releaseProviderProbeLease(
        target.providerAccountId,
        owner,
        leaseVersion,
        now().toISOString(),
      );
      return false;
    }
    deps.repository.setProviderState(
      target.providerAccountId,
      owner,
      leaseVersion,
      {
        status: 'available',
        consecutiveFailures: 0,
        retryAt: null,
        resetAt: null,
        sanitizedReason: null,
        recoveredAt: now().toISOString(),
      },
      now().toISOString(),
    );
    deps.repository.releaseProviderProbeLease(
      target.providerAccountId,
      owner,
      leaseVersion,
      now().toISOString(),
    );
    emit({
      type: 'podsitter.provider_recovered',
      timestamp: now().toISOString(),
      providerAccountId: target.providerAccountId,
    });
    return true;
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = deps.eventBus.subscribe((event) => {
        if (relevantEvent(event)) void serialize(() => reconcileInternal());
      });
      timer = setInterval(
        () => void serialize(() => reconcileInternal()),
        deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS,
      );
      await serialize(async () => {
        if (deps.reapLeakedSandboxes) {
          await deps.reapLeakedSandboxes();
          for (const leaked of deps.repository.listActiveSandboxRuns()) {
            emit({
              type: 'podsitter.system_sandbox_cleanup_failed',
              timestamp: now().toISOString(),
              runId: leaked.id,
              decisionId: leaked.decisionId,
              failureCode: 'CLEANUP_RETRYABLE',
            });
          }
        }
        const configuration = deps.repository.getConfiguration();
        const target = configuration?.decisionTarget;
        if (target && configuration && evaluatePodsitterActivation(configuration, now()).active) {
          const state = deps.repository.getProviderState(target.providerAccountId);
          if (state?.retryAt && Date.parse(state.retryAt) <= now().getTime()) {
            await probeInternal();
          }
        }
        await reconcileInternal();
      });
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      await chain;
    },
    reconcile: (options) => serialize(() => reconcileInternal(options)),
    probe: () =>
      serialize(async () => {
        const recovered = await probeInternal();
        if (recovered) await reconcileInternal();
        return recovered;
      }),
    status() {
      const configuration = deps.repository.getConfiguration();
      const target = configuration?.decisionTarget;
      return {
        configuration,
        activation: configuration ? evaluatePodsitterActivation(configuration, now()) : null,
        provider: target ? deps.repository.getProviderState(target.providerAccountId) : null,
        queueCount: deps.repository.listPendingAttention().length,
      };
    },
  };
}

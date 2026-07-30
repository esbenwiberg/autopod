import type { Pod, PodStatus, PodsitterConfiguration } from '@autopod/shared';
import type { EscalationRepository } from '../pods/escalation-repository.js';
import type { EventRepository } from '../pods/event-repository.js';
import type { PodManager } from '../pods/pod-manager.js';
import type { ProviderAttemptRepository } from '../pods/provider-attempt-repository.js';
import { buildPodsitterEvidence, podsitterAttentionSignature } from './evidence-builder.js';
import type { PodsitterRepository } from './podsitter-repository.js';
import type { PodsitterCandidate, PodsitterEvidenceProvider } from './podsitter-service.js';

const ATTENTION_STATUSES = new Set<PodStatus>([
  'awaiting_input',
  'paused',
  'failed',
  'review_required',
  'validated',
  'merge_pending',
]);
const STALE_STATUSES = new Set<PodStatus>(['queued', 'provisioning', 'running', 'validating']);
const STALE_MS = 15 * 60_000;

export function createDaemonPodsitterEvidenceProvider(deps: {
  podManager: PodManager;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  providerAttemptRepo: ProviderAttemptRepository;
  repository: PodsitterRepository;
}): PodsitterEvidenceProvider {
  function buildCandidate(
    podId: string,
    now: Date,
    configuration: PodsitterConfiguration | null,
  ): PodsitterCandidate | null {
    let pod: Pod;
    try {
      pod = deps.podManager.getSession(podId);
    } catch {
      return null;
    }
    if (configuration?.profileScope && !configuration.profileScope.includes(pod.profileName)) {
      return null;
    }
    const referenceTime = Date.parse(pod.lastActivityAt ?? pod.updatedAt ?? pod.createdAt);
    const stale =
      STALE_STATUSES.has(pod.status) &&
      Number.isFinite(referenceTime) &&
      now.getTime() - referenceTime >= STALE_MS;
    if (!ATTENTION_STATUSES.has(pod.status) && !stale) return null;
    const escalations = deps.escalationRepo.listBySession(pod.id);
    const pendingEscalations = escalations.filter((item) => !item.response);
    const validationHistory = deps.podManager.getValidationHistory(pod.id);
    const providerAttempts = deps.providerAttemptRepo.list(pod.id);
    const recentEvents = deps.eventRepo.getForSession(pod.id, { latest: 30 });
    const seriesGraph = pod.seriesId
      ? deps.podManager
          .listSessions()
          .filter((candidate) => candidate.seriesId === pod.seriesId)
          .map((candidate) => ({
            id: candidate.id,
            status: candidate.status,
            dependsOnPodIds: candidate.dependsOnPodIds ?? [],
          }))
      : [];
    const policyState = {
      status: pod.status,
      attempt: pod.validationAttempts,
      failureReason: pod.failureReason ?? null,
      worktreeCompromised: pod.worktreeCompromised ?? false,
      readiness: pod.readinessReview ?? null,
      validation: pod.lastValidationResult ?? null,
      pendingEscalations: pendingEscalations.map((item) => ({ id: item.id, type: item.type })),
      prUrl: pod.prUrl ?? null,
      seriesId: pod.seriesId ?? null,
      dependsOnPodIds: pod.dependsOnPodIds ?? null,
    };
    const signature = podsitterAttentionSignature(policyState, stale);
    const generatedAt = now.toISOString();
    const evidence = buildPodsitterEvidence({
      podId: pod.id,
      generatedAt,
      sources: [
        { ref: 'pod:state', value: policyState, maxBytes: 16_000 },
        {
          ref: 'pod:task-contract',
          value: {
            task: pod.task,
            contract: pod.contract,
            taskSummary: pod.taskSummary,
            seriesDescription: pod.seriesDescription,
            seriesDesign: pod.seriesDesign,
          },
          maxBytes: 20_000,
        },
        { ref: 'escalations:recent', value: escalations.slice(-20), maxBytes: 12_000 },
        { ref: 'validation:history', value: validationHistory.slice(-5), maxBytes: 20_000 },
        { ref: 'provider:attempts', value: providerAttempts.slice(-10), maxBytes: 8_000 },
        {
          ref: 'events:recent',
          value: recentEvents,
          maxBytes: 16_000,
        },
        {
          ref: 'logs:agent-build-tail',
          value: recentEvents.filter(
            (event) =>
              event.type === 'pod.agent_activity' ||
              event.type === 'pod.validation_phase_completed',
          ),
          maxBytes: 12_000,
        },
        {
          ref: 'worktree:state',
          value: {
            pathPresent: Boolean(pod.worktreePath),
            compromised: pod.worktreeCompromised ?? false,
            branch: pod.branch,
            prUrl: pod.prUrl ?? null,
          },
          maxBytes: 4_000,
        },
        { ref: 'series:graph', value: seriesGraph, maxBytes: 8_000 },
        {
          ref: 'diff:bounded',
          value: { unavailable: true, reason: 'No safe diff reader is available for this backend' },
          maxBytes: 1_000,
          unavailable: true,
        },
        {
          ref: 'touched-files:excerpts',
          value: {
            unavailable: true,
            reason: 'No safe touched-file excerpt reader is available for this backend',
          },
          maxBytes: 1_000,
          unavailable: true,
        },
        {
          ref: 'podsitter:prior-decisions',
          value: deps.repository.listDecisions({ podId: pod.id, limit: 10 }).items,
          maxBytes: 12_000,
        },
      ],
    });
    const validationPass = pod.lastValidationResult?.overall === 'pass';
    const deterministicApproval =
      pod.status === 'validated' &&
      pod.readinessReview?.status === 'ready' &&
      validationPass &&
      !pod.worktreeCompromised &&
      pendingEscalations.length === 0 &&
      !pod.failureReason;
    return {
      pod,
      signature,
      failureSignature: signature,
      evidence,
      deterministicApproval,
    };
  }

  return {
    async listCandidates(now, configuration) {
      return deps.podManager
        .listSessions()
        .map((pod) => buildCandidate(pod.id, now, configuration))
        .filter((candidate): candidate is PodsitterCandidate => candidate !== null);
    },
    async getCandidate(podId, now, configuration) {
      return buildCandidate(podId, now, configuration);
    },
  };
}

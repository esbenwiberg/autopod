import type { Pod, PodStatus, PodsitterConfiguration } from '@autopod/shared';
import type { Logger } from 'pino';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { EscalationRepository } from '../pods/escalation-repository.js';
import type { EventRepository } from '../pods/event-repository.js';
import { computePodDiff, computePodUntrackedPreview } from '../pods/pod-diff-fetcher.js';
import type { ContainerManagerFactory, PodManager } from '../pods/pod-manager.js';
import type { ProviderAttemptRepository } from '../pods/provider-attempt-repository.js';
import { type ProfileStore, selectGitPat } from '../profiles/index.js';
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
const MAX_DIFF_BYTES = 24_000;
const MAX_TOUCHED_FILES = 8;
const MAX_FILE_EXCERPT_BYTES = 1_200;

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n[truncated]';
  return `${Buffer.from(value, 'utf8')
    .subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix)))
    .toString('utf8')}${suffix}`;
}

function touchedFileExcerpts(diff: string): Array<{ path: string; excerpt: string }> {
  return diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .slice(0, MAX_TOUCHED_FILES)
    .flatMap((chunk) => {
      const lines = chunk.split('\n');
      const path =
        lines
          .find((line) => line.startsWith('+++ b/'))
          ?.slice(6)
          .trim() ??
        lines
          .find((line) => line.startsWith('--- a/'))
          ?.slice(6)
          .trim();
      if (!path) return [];
      const excerpt = lines
        .filter(
          (line) =>
            line.startsWith('@@') ||
            (line.startsWith('+') && !line.startsWith('+++')) ||
            (line.startsWith('-') && !line.startsWith('---')),
        )
        .join('\n');
      return [{ path, excerpt: boundUtf8(excerpt, MAX_FILE_EXCERPT_BYTES) }];
    });
}

export function createDaemonPodsitterEvidenceProvider(deps: {
  podManager: PodManager;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  providerAttemptRepo: ProviderAttemptRepository;
  repository: PodsitterRepository;
  containerManagerFactory: ContainerManagerFactory;
  profileStore: ProfileStore;
  worktreeManager: WorktreeManager;
  logger: Logger;
}): PodsitterEvidenceProvider {
  async function readDiff(
    pod: Pod,
  ): Promise<{ diff: string; source: string; unavailable: boolean }> {
    const profile = (() => {
      try {
        return deps.profileStore.get(pod.profileName);
      } catch {
        return null;
      }
    })();
    const defaultBranch = pod.baseBranch ?? profile?.defaultBranch ?? 'main';
    const containerManager = pod.containerId
      ? deps.containerManagerFactory.get(pod.executionTarget)
      : undefined;
    try {
      const podSlice = {
        containerId: pod.containerId ?? null,
        worktreePath: pod.worktreePath ?? null,
        startCommitSha: pod.startCommitSha ?? null,
      };
      const [tracked, untracked] = await Promise.all([
        computePodDiff({
          pod: podSlice,
          defaultBranch,
          containerManager,
          worktreeManager: deps.worktreeManager,
          maxLength: MAX_DIFF_BYTES,
          logger: deps.logger,
        }),
        computePodUntrackedPreview({
          pod: podSlice,
          defaultBranch,
          containerManager,
          worktreeManager: deps.worktreeManager,
          logger: deps.logger,
        }),
      ]);
      let diff = [tracked.diff, ...untracked.files.map((file) => file.diff)]
        .filter(Boolean)
        .join('\n');
      let source = tracked.source !== 'none' ? tracked.source : untracked.source;
      if (source === 'none' && profile?.repoUrl && deps.worktreeManager.getBranchDiff) {
        diff = await deps.worktreeManager.getBranchDiff({
          repoUrl: profile.repoUrl,
          branch: pod.branch,
          baseBranch: defaultBranch,
          pat: selectGitPat(profile),
          startCommitSha: pod.startCommitSha,
        });
        if (diff.trim()) source = 'worktree';
      }
      return {
        diff: boundUtf8(diff, MAX_DIFF_BYTES),
        source,
        unavailable: source === 'none',
      };
    } catch (error) {
      deps.logger.warn({ err: error, podId: pod.id }, 'Podsitter diff evidence unavailable');
      return { diff: '', source: 'none', unavailable: true };
    }
  }

  async function buildCandidate(
    podId: string,
    now: Date,
    configuration: PodsitterConfiguration | null,
  ): Promise<PodsitterCandidate | null> {
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
    const diff = await readDiff(pod);
    const excerpts = touchedFileExcerpts(diff.diff);
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
      mergeBlockReason: pod.mergeBlockReason ?? null,
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
        { ref: 'pod:state', value: policyState, maxBytes: 12_000 },
        {
          ref: 'pod:task-contract',
          value: {
            task: pod.task,
            contract: pod.contract,
            taskSummary: pod.taskSummary,
            seriesDescription: pod.seriesDescription,
            seriesDesign: pod.seriesDesign,
          },
          maxBytes: 16_000,
        },
        {
          ref: 'logs:agent-build-tail',
          value: recentEvents.filter(
            (event) =>
              event.type === 'pod.agent_activity' ||
              event.type === 'pod.validation_phase_completed',
          ),
          maxBytes: 10_000,
        },
        {
          ref: 'diff:bounded',
          value: { source: diff.source, diff: diff.diff },
          maxBytes: 25_000,
          unavailable: diff.unavailable,
        },
        {
          ref: 'touched-files:excerpts',
          value: excerpts,
          maxBytes: 10_000,
          unavailable: diff.unavailable,
        },
        { ref: 'escalations:recent', value: escalations.slice(-20), maxBytes: 8_000 },
        { ref: 'validation:history', value: validationHistory.slice(-5), maxBytes: 12_000 },
        { ref: 'provider:attempts', value: providerAttempts.slice(-10), maxBytes: 6_000 },
        { ref: 'events:recent', value: recentEvents, maxBytes: 8_000 },
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
        { ref: 'series:graph', value: seriesGraph, maxBytes: 6_000 },
        {
          ref: 'podsitter:prior-decisions',
          value: deps.repository.listDecisions({ podId: pod.id, limit: 10 }).items,
          maxBytes: 8_000,
        },
      ],
    });
    const validationPass = pod.lastValidationResult?.overall === 'pass';
    const deterministicApproval =
      pod.status === 'validated' &&
      pod.readinessReview?.status === 'ready' &&
      validationPass &&
      !pod.worktreeCompromised &&
      !pod.mergeBlockReason &&
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
      const candidates = await Promise.all(
        deps.podManager.listSessions().map((pod) => buildCandidate(pod.id, now, configuration)),
      );
      return candidates.filter((candidate): candidate is PodsitterCandidate => candidate !== null);
    },
    async getCandidate(podId, now, configuration) {
      return buildCandidate(podId, now, configuration);
    },
  };
}

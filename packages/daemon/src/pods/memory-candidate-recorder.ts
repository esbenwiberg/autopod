import type {
  AgentActivityEvent,
  AgentTaskSummaryEvent,
  EscalationType,
  PodCompletedEvent,
  PodStatus,
  PodStatusChangedEvent,
  Profile,
  QualitySignals,
  SystemEvent,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ProfileStore } from '../profiles/index.js';
import { createProfileMemoryReviewer } from '../providers/memory-reviewer.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { MemoryCandidateRepository } from './memory-candidate-repository.js';
import type { MemoryExtractionAttemptRepository } from './memory-extraction-attempt-repository.js';
import {
  LESSON_POTENTIAL_THRESHOLD,
  computeLessonPotential,
  extractCandidate,
} from './memory-extraction.js';
import type { MemoryRepository } from './memory-repository.js';
import type { PodRepository } from './pod-repository.js';
import { computeQualitySignals } from './quality-signals.js';
import { resolveReviewerModel } from './runtime-resolver.js';
import type { ValidationRepository } from './validation-repository.js';

export interface MemoryCandidateRecorder {
  start(): void;
  stop(): void;
}

export interface MemoryCandidateRecorderDeps {
  eventBus: EventBus;
  podRepo: PodRepository;
  profileStore: ProfileStore;
  candidateRepo: MemoryCandidateRepository;
  attemptRepo?: MemoryExtractionAttemptRepository;
  memoryRepo: MemoryRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  validationRepo?: ValidationRepository;
  logger: Logger;
}

const EXTRACTION_STATUSES: PodStatus[] = ['failed', 'review_required'];

type ExtractionOutcome = 'done' | 'retryable' | 'ignored';

/**
 * Listens for pod outcome events and extracts at most one durable profile
 * memory candidate per pod via a reviewer-model LLM call.
 *
 * Extraction targets: `pod.completed` (complete/killed) and
 * `pod.status_changed` (failed/review_required). Interactive workspace pods
 * (`agentMode !== 'auto'`) are always skipped. LLM failures are logged and
 * swallowed — extraction never affects pod lifecycle.
 */
export function createMemoryCandidateRecorder(
  deps: MemoryCandidateRecorderDeps,
): MemoryCandidateRecorder {
  const {
    eventBus,
    podRepo,
    profileStore,
    candidateRepo,
    attemptRepo,
    memoryRepo,
    eventRepo,
    escalationRepo,
    validationRepo,
    logger,
  } = deps;

  const unsubscribers: Array<() => void> = [];
  // In-memory sets for fast idempotency — survive within one daemon instance.
  // `processedPodIds` means extraction reached a durable decision, not merely
  // that we saw an early status event.
  const processedPodIds = new Set<string>();
  const inFlightPodIds = new Set<string>();

  function recordAttempt(input: {
    podId: string;
    profileName: string;
    status: Parameters<MemoryExtractionAttemptRepository['record']>[0]['status'];
    reason: string;
    score: number | null;
    signals: string[];
    candidateId?: string | null;
  }): void {
    try {
      attemptRepo?.record({
        podId: input.podId,
        profileName: input.profileName,
        status: input.status,
        reason: input.reason,
        score: input.score,
        signals: input.signals,
        candidateId: input.candidateId ?? null,
      });
    } catch (err) {
      logger.warn({ err, podId: input.podId }, 'Failed to record memory extraction attempt');
    }
  }

  async function runExtraction(podId: string): Promise<ExtractionOutcome> {
    // Double-check DB idempotency: handles daemon restarts between events.
    if (candidateRepo.existsForPod(podId)) {
      logger.debug({ podId }, 'Skipping extraction: candidate already exists for pod');
      return 'done';
    }

    const pod = podRepo.getOrThrow(podId);

    // Only extract for future agent-driven pods.
    if (pod.options.agentMode !== 'auto') {
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'skipped',
        reason: 'agent_mode_not_auto',
        score: null,
        signals: [],
      });
      return 'ignored';
    }

    let profile: Profile;
    try {
      profile = profileStore.get(pod.profileName);
    } catch {
      logger.warn(
        { podId, profileName: pod.profileName },
        'Profile not found, skipping extraction',
      );
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'skipped',
        reason: 'profile_not_found',
        score: null,
        signals: [],
      });
      return 'ignored';
    }

    const signals: QualitySignals = computeQualitySignals(podId, {
      podRepo,
      eventRepo,
      escalationRepo,
      validationRepo,
    });

    const { score, signals: lessonSignals } = computeLessonPotential(pod, signals);

    if (score < LESSON_POTENTIAL_THRESHOLD) {
      logger.debug({ podId, score }, 'Lesson potential below threshold, skipping extraction');
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'below_threshold',
        reason: 'lesson_potential_below_threshold',
        score,
        signals: lessonSignals,
      });
      return 'retryable';
    }

    // Build evidence from stored events and escalations.
    const evidence = buildEvidence(podId, { eventRepo, escalationRepo, validationRepo });

    const existingMemories = memoryRepo.list('profile', pod.profileName, true);

    const reviewerModelId = resolveReviewerModel(profile, logger);
    const reviewerResult = await createProfileMemoryReviewer(profile, reviewerModelId, logger);
    if (!reviewerResult.ok) {
      logger.warn(
        { podId, reason: reviewerResult.reason },
        'Reviewer model unavailable for memory extraction',
      );
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'reviewer_unavailable',
        reason: reviewerResult.reason,
        score,
        signals: lessonSignals,
      });
      return 'retryable';
    }

    const result = await extractCandidate({
      pod,
      lessonSignals,
      evidence,
      existingMemories,
      reviewer: reviewerResult.reviewer,
      reviewerModel: reviewerResult.model,
      logger,
    });

    if (result.kind === 'candidate') {
      const candidate = candidateRepo.insert(result.input);
      eventBus.emit({
        type: 'memory.candidate_created',
        timestamp: new Date().toISOString(),
        podId,
        candidate,
      });
      logger.info(
        { podId, candidateId: candidate.id, action: candidate.action, path: candidate.path },
        'Memory candidate created',
      );
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'candidate_created',
        reason: 'candidate_created',
        score,
        signals: lessonSignals,
        candidateId: candidate.id,
      });
      return 'done';
    }

    if (result.kind === 'no_candidate') {
      logger.debug(
        { podId, kind: result.kind, reason: result.reason },
        'No memory candidate created',
      );
      recordAttempt({
        podId,
        profileName: pod.profileName,
        status: 'no_candidate',
        reason: result.reason,
        score,
        signals: lessonSignals,
      });
      return 'done';
    }

    logger.debug(
      { podId, kind: result.kind, reason: result.reason },
      'No memory candidate created',
    );
    recordAttempt({
      podId,
      profileName: pod.profileName,
      status: classifySkippedResult(result.reason),
      reason: result.reason,
      score,
      signals: lessonSignals,
    });
    return 'retryable';
  }

  function maybeTrigger(podId: string): void {
    if (processedPodIds.has(podId)) return;
    if (inFlightPodIds.has(podId)) return;

    inFlightPodIds.add(podId);

    void runExtraction(podId)
      .then((outcome) => {
        if (outcome === 'done') {
          processedPodIds.add(podId);
        }
      })
      .catch((err) => {
        logger.warn({ err, podId }, 'Memory candidate extraction error');
      })
      .finally(() => {
        inFlightPodIds.delete(podId);
      });
  }

  function handleEvent(event: SystemEvent): void {
    if (event.type === 'pod.completed') {
      const e = event as PodCompletedEvent;
      maybeTrigger(e.podId);
    } else if (event.type === 'pod.status_changed') {
      const e = event as PodStatusChangedEvent;
      if (EXTRACTION_STATUSES.includes(e.newStatus)) {
        maybeTrigger(e.podId);
      }
    }
  }

  return {
    start(): void {
      const unsub = eventBus.subscribe(handleEvent);
      unsubscribers.push(unsub);
      logger.info('Memory candidate recorder started');
    },

    stop(): void {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
    },
  };
}

function classifySkippedResult(reason: string): 'reviewer_failed' | 'invalid_response' | 'skipped' {
  if (reason.startsWith('reviewer_model_failed')) return 'reviewer_failed';
  if (reason.startsWith('json_parse_failed') || reason.startsWith('output_invalid')) {
    return 'invalid_response';
  }
  return 'skipped';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface EvidenceDeps {
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  validationRepo?: ValidationRepository;
}

function buildEvidence(
  podId: string,
  { eventRepo, escalationRepo, validationRepo }: EvidenceDeps,
): import('./memory-extraction.js').ExtractionEvidence {
  let taskSummary: string | undefined;
  let how: string | undefined;

  // Pull the last task_summary event emitted by the agent.
  const events = eventRepo.getForSession(podId);
  for (const stored of events) {
    if (stored.type !== 'pod.agent_activity') continue;
    const activity = stored.payload as AgentActivityEvent;
    if (activity.event.type === 'task_summary') {
      const ts = activity.event as AgentTaskSummaryEvent;
      taskSummary = ts.actualSummary;
      how = ts.how;
    }
  }

  // Collect report_blocker escalation messages.
  const blockerType: EscalationType = 'report_blocker';
  const blockerMessages = escalationRepo
    .listBySession(podId)
    .filter((e) => e.type === blockerType)
    .map((e) => {
      const payload = e.payload as { message?: string } | undefined;
      return payload?.message ?? '';
    })
    .filter(Boolean);

  // Summarise the most recent failed validation attempt.
  let validationErrors: string | undefined;
  if (validationRepo) {
    const validations = validationRepo.getForSession(podId);
    const failed = [...validations].reverse().find((v) => v.result.overall !== 'pass');
    if (failed) {
      const r = failed.result;
      const failedParts: string[] = [];
      if (r.smoke?.build?.status === 'fail') failedParts.push('build');
      if (r.smoke?.health?.status === 'fail') failedParts.push('health');
      if (r.test?.status === 'fail') failedParts.push('test');
      if (r.lint?.status === 'fail') failedParts.push('lint');
      if (r.sast?.status === 'fail') failedParts.push('sast');
      if (r.taskReview?.status === 'fail') failedParts.push('task_review');
      validationErrors =
        failedParts.length > 0 ? `Failed phases: ${failedParts.join(', ')}` : 'validation failed';
    }
  }

  return { taskSummary, how, blockerMessages, validationErrors };
}

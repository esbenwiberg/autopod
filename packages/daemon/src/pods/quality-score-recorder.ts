import type { PodCompletedEvent, SystemEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import { QUALITY_SCORE_ALGORITHM_VERSION } from './quality-score-repository.js';
import { computeScore } from './quality-score.js';
import { computeQualitySignals } from './quality-signals.js';
import type { ValidationRepository } from './validation-repository.js';

export interface QualityScoreRecorder {
  upgradeHistory(limit?: number): number;
  start(): void;
  stop(): void;
}

export interface QualityScoreRecorderDeps {
  eventBus: EventBus;
  podRepo: PodRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  qualityScoreRepo: QualityScoreRepository;
  logger: Logger;
  /** Optional — when wired, validation outcome is included in the score. */
  validationRepo?: ValidationRepository;
  providerAttemptRepo?: ProviderAttemptRepository;
}

/**
 * Listens for `pod.completed` and writes one `pod_quality_scores` row per
 * terminal pod. Failures are logged and swallowed — a bad score must never
 * block the pod lifecycle. Idempotent via `INSERT … ON CONFLICT` in the repo.
 */
export function createQualityScoreRecorder(deps: QualityScoreRecorderDeps): QualityScoreRecorder {
  const {
    eventBus,
    podRepo,
    eventRepo,
    escalationRepo,
    qualityScoreRepo,
    validationRepo,
    providerAttemptRepo,
    logger,
  } = deps;
  const unsubscribers: Array<() => void> = [];

  function persistScore(
    podId: string,
    finalStatus: 'complete' | 'killed',
    completedAt: string,
  ): void {
    const pod = podRepo.getOrThrow(podId);
    const signals = computeQualitySignals(podId, {
      podRepo,
      eventRepo,
      escalationRepo,
      validationRepo,
      providerAttemptRepo,
    });
    const computedScore = computeScore({ signals, finalStatus });
    const available = signals.inspectionAvailability === 'available';

    qualityScoreRepo.insert({
      podId,
      score: available ? computedScore : null,
      algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
      inspectionAvailability: signals.inspectionAvailability,
      readCount: signals.readCount,
      editCount: signals.editCount,
      readEditRatio: signals.readEditRatio,
      editsWithoutPriorRead: signals.editsWithoutPriorRead,
      userInterrupts: signals.userInterrupts,
      editChurnCount: signals.editChurnCount,
      tellsCount: signals.tellsCount,
      prFixAttempts: signals.prFixAttempts,
      validationPassed: signals.validationPassed,
      inputTokens: signals.tokens.input,
      outputTokens: signals.tokens.output,
      costUsd: signals.tokens.costUsd,
      runtime: pod.runtime,
      profileName: pod.profileName,
      model: pod.model,
      finalStatus,
      completedAt,
      computedAt: new Date().toISOString(),
    });

    logger.debug(
      {
        podId,
        score: available ? computedScore : null,
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability: signals.inspectionAvailability,
        grade: signals.grade,
        runtime: pod.runtime,
        model: pod.model,
        tellsCount: signals.tellsCount,
        editChurnCount: signals.editChurnCount,
      },
      'Recorded pod quality score',
    );
  }

  function recordFor(event: PodCompletedEvent): void {
    try {
      persistScore(event.podId, event.finalStatus, event.timestamp);
    } catch (err) {
      logger.warn({ err, podId: event.podId }, 'Failed to record pod quality score');
    }
  }

  function handleEvent(event: SystemEvent): void {
    if (event.type !== 'pod.completed') return;
    recordFor(event);
  }

  return {
    upgradeHistory(limit = 100): number {
      const stale = qualityScoreRepo.listStale(limit);
      let upgraded = 0;
      for (const score of stale) {
        try {
          persistScore(score.podId, score.finalStatus, score.completedAt);
          upgraded += 1;
        } catch (err) {
          logger.warn({ err, podId: score.podId }, 'Failed to upgrade pod quality score');
        }
      }
      logger.info(
        { upgraded, selected: stale.length, limit },
        'Quality score history upgrade completed',
      );
      return upgraded;
    },

    start(): void {
      const unsub = eventBus.subscribe(handleEvent);
      unsubscribers.push(unsub);
      logger.info('Quality score recorder started');
    },

    stop(): void {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
    },
  };
}

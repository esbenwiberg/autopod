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
  upgradeHistory(
    limit?: number,
    afterPodId?: string,
  ): { selected: number; upgraded: number; lastPodId: string | null };
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
  /** Recompute dependent snapshots after the score row is durably persisted. */
  onScorePersisted?: (podId: string) => void;
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
    onScorePersisted,
    logger,
  } = deps;
  const unsubscribers: Array<() => void> = [];

  function refreshAfterPersistence(podId: string): boolean {
    try {
      onScorePersisted?.(podId);
      return true;
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to refresh readiness after quality score persistence');
      return false;
    }
  }

  function persistScore(
    podId: string,
    finalStatus: 'complete' | 'killed',
    completedAt: string,
    options: { historical?: boolean } = {},
  ): boolean {
    const pod = podRepo.getOrThrow(podId);
    const signals = computeQualitySignals(podId, {
      podRepo,
      eventRepo,
      escalationRepo,
      validationRepo,
      providerAttemptRepo,
    });
    const computedScore = computeScore({ signals, finalStatus });
    const attempts = providerAttemptRepo?.list(podId) ?? [];
    const hasPiAttempt =
      pod.runtime === 'pi' || attempts.some((attempt) => attempt.runtime === 'pi');
    const hasNonPiAttempt =
      pod.runtime !== 'pi' || attempts.some((attempt) => attempt.runtime !== 'pi');
    // Retained events do not carry provider-attempt attribution. A mixed Pi
    // outcome therefore cannot prove that the Pi portion is complete, even
    // when unrelated normalized evidence survives from another attempt.
    const mixedPiEvidenceIncomplete = hasPiAttempt && hasNonPiAttempt;
    // Pi activity was not durably retained before the normalized parser
    // contract. Surviving historical events can therefore be only a subset;
    // without a completeness marker, no stale Pi row is safe to recompute.
    const historicalPiEvidenceIncomplete = options.historical === true && hasPiAttempt;
    const available =
      signals.inspectionAvailability === 'available' &&
      !mixedPiEvidenceIncomplete &&
      !historicalPiEvidenceIncomplete;
    const inspectionAvailability = available ? 'available' : 'unavailable';

    qualityScoreRepo.insert({
      podId,
      score: available ? computedScore : null,
      algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
      inspectionAvailability,
      readCount: available ? signals.readCount : null,
      editCount: signals.editCount,
      readEditRatio: available ? signals.readEditRatio : null,
      editsWithoutPriorRead: available ? signals.editsWithoutPriorRead : null,
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

    const readinessRefreshed = refreshAfterPersistence(podId);

    logger.debug(
      {
        podId,
        score: available ? computedScore : null,
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability,
        grade: signals.grade,
        runtime: pod.runtime,
        model: pod.model,
        tellsCount: signals.tellsCount,
        editChurnCount: signals.editChurnCount,
      },
      'Recorded pod quality score',
    );
    return readinessRefreshed;
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
    upgradeHistory(limit = 100, afterPodId?: string) {
      const stale = qualityScoreRepo.listUpgradeCandidates(limit, afterPodId);
      let upgraded = 0;
      for (const score of stale) {
        try {
          const readinessRefreshed =
            score.algorithmVersion === QUALITY_SCORE_ALGORITHM_VERSION
              ? refreshAfterPersistence(score.podId)
              : persistScore(score.podId, score.finalStatus, score.completedAt, {
                  historical: true,
                });
          if (readinessRefreshed) upgraded += 1;
        } catch (err) {
          logger.warn({ err, podId: score.podId }, 'Failed to upgrade pod quality score');
        }
      }
      logger.info(
        { upgraded, selected: stale.length, limit },
        'Quality score history upgrade completed',
      );
      return {
        selected: stale.length,
        upgraded,
        lastPodId: stale.at(-1)?.podId ?? null,
      };
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

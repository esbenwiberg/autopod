import type { PodCompletedEvent, SystemEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import type { ValidationRepository } from './validation-repository.js';
import { computeScore } from './quality-score.js';
import { computeQualitySignals } from './quality-signals.js';

export interface QualityScoreRecorder {
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
}

/**
 * Listens for `pod.completed` and writes one `pod_quality_scores` row per
 * terminal pod. Failures are logged and swallowed — a bad score must never
 * block the pod lifecycle. Idempotent via `INSERT … ON CONFLICT` in the repo.
 */
export function createQualityScoreRecorder(deps: QualityScoreRecorderDeps): QualityScoreRecorder {
  const { eventBus, podRepo, eventRepo, escalationRepo, qualityScoreRepo, validationRepo, logger } =
    deps;
  const unsubscribers: Array<() => void> = [];

  function recordFor(event: PodCompletedEvent): void {
    try {
      const pod = podRepo.getOrThrow(event.podId);
      const signals = computeQualitySignals(event.podId, {
        podRepo,
        eventRepo,
        escalationRepo,
        validationRepo,
      });
      const score = computeScore({ signals, finalStatus: event.finalStatus });

      qualityScoreRepo.insert({
        podId: event.podId,
        score,
        readCount: signals.readCount,
        editCount: signals.editCount,
        readEditRatio: signals.readEditRatio,
        editsWithoutPriorRead: signals.editsWithoutPriorRead,
        userInterrupts: signals.userInterrupts,
        editChurnCount: signals.editChurnCount,
        tellsCount: signals.tellsCount,
        prFixAttempts: signals.prFixAttempts,
        validationPassed: signals.validationPassed,
        inputTokens: pod.inputTokens,
        outputTokens: pod.outputTokens,
        costUsd: pod.costUsd,
        runtime: pod.runtime,
        profileName: pod.profileName,
        // Record the exact model string at completion time — critical for 3d,
        // since a silent server-side model swap is invisible without it.
        model: pod.model,
        finalStatus: event.finalStatus,
        completedAt: event.timestamp,
        computedAt: new Date().toISOString(),
      });

      logger.debug(
        {
          podId: event.podId,
          score,
          grade: signals.grade,
          runtime: pod.runtime,
          model: pod.model,
          tellsCount: signals.tellsCount,
          editChurnCount: signals.editChurnCount,
        },
        'Recorded pod quality score',
      );
    } catch (err) {
      logger.warn({ err, podId: event.podId }, 'Failed to record pod quality score');
    }
  }

  function handleEvent(event: SystemEvent): void {
    if (event.type !== 'pod.completed') return;
    recordFor(event);
  }

  return {
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

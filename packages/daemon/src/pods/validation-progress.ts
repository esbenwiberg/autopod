import type {
  BuildResult,
  FactValidationResult,
  HealthResult,
  LintResult,
  PageResult,
  ReviewProgressSnapshot,
  SastResult,
  SetupResult,
  TaskReviewResult,
  ValidationPhase,
  ValidationPhaseStartedEvent,
  ValidationResult,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type {
  ValidationEngine,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import type { EventBus } from './event-bus.js';
import type { captureValidationOwnership } from './validation-ownership.js';
import {
  type createValidationPhaseTimings,
  type ValidationTimingContext,
  validationPhaseTimingKey,
} from './validation-phase-timings.js';

interface ValidationProgressDependencies {
  eventBus: Pick<EventBus, 'emit'>;
  timing?: ReturnType<typeof createValidationPhaseTimings>;
  logger?: Pick<Logger, 'warn'>;
}
type PhaseEventCallbacks = Required<ValidationPhaseCallbacks>;

export function createValidationProgress(deps: ValidationProgressDependencies): {
  buildPhaseEventCallbacks(podId: string, context?: ValidationTimingContext): PhaseEventCallbacks;
  ownedValidationCallbacks(
    ownership: ReturnType<typeof captureValidationOwnership>,
    callbacks: Parameters<ValidationEngine['validate']>[3],
  ): NonNullable<Parameters<ValidationEngine['validate']>[3]>;
} {
  const { eventBus } = deps;

  /** Per-phase WebSocket events that drive the desktop Validation tab chips.
   *  Pass to every `validationEngine.validate()` call — the engine no-ops on
   *  missing callbacks, which silently freezes the UI. */
  function buildPhaseEventCallbacks(podId: string, context?: ValidationTimingContext) {
    const samples = new Map<ValidationPhase, { key: string; startedMs: number }>();
    return {
      onPhaseStarted: (phase: ValidationPhase) => {
        const timestamp = new Date().toISOString();
        let estimate: ValidationPhaseStartedEvent['estimate'];
        if (context && deps.timing) {
          try {
            const key = validationPhaseTimingKey(context, phase);
            if (key) {
              samples.set(phase, { key, startedMs: performance.now() });
              estimate = deps.timing.estimate(key);
            }
          } catch (error) {
            deps.logger?.warn({ error, podId, phase }, 'Validation timing estimate unavailable');
          }
        }
        eventBus.emit({
          type: 'pod.validation_phase_started',
          timestamp,
          podId,
          phase,
          ...(estimate ? { estimate } : {}),
        });
      },
      onPhaseCompleted: (
        phase: ValidationPhase,
        status: 'pass' | 'fail' | 'skip' | 'pending_human',
        phaseResult: unknown,
      ) => {
        const sample = samples.get(phase);
        samples.delete(phase);
        const result = phaseResult as { duration?: number; reusedEvidence?: unknown } | null;
        const didRun = phase === 'pages' || (result?.duration ?? 0) > 0;
        // Failed checks can exit early (or hit a timeout); neither is the usual runtime.
        if (sample && status === 'pass' && didRun && !result?.reusedEvidence) {
          try {
            deps.timing?.record(sample.key, Math.round(performance.now() - sample.startedMs));
          } catch (error) {
            deps.logger?.warn({ error, podId, phase }, 'Could not save validation timing sample');
          }
        }
        const base = {
          type: 'pod.validation_phase_completed' as const,
          timestamp: new Date().toISOString(),
          podId,
          phase,
          phaseStatus: status,
        };
        if (phase === 'setup') {
          eventBus.emit({ ...base, setupResult: phaseResult as SetupResult });
        } else if (phase === 'build') {
          eventBus.emit({ ...base, buildResult: phaseResult as BuildResult });
        } else if (phase === 'test') {
          eventBus.emit({
            ...base,
            testResult: phaseResult as {
              status: 'pass' | 'fail' | 'skip';
              duration: number;
              stdout?: string;
              stderr?: string;
            },
          });
        } else if (phase === 'lint') {
          eventBus.emit({ ...base, lintResult: phaseResult as LintResult });
        } else if (phase === 'sast') {
          eventBus.emit({ ...base, sastResult: phaseResult as SastResult });
        } else if (phase === 'health') {
          eventBus.emit({ ...base, healthResult: phaseResult as HealthResult });
        } else if (phase === 'pages') {
          eventBus.emit({ ...base, pageResults: phaseResult as PageResult[] });
        } else if (phase === 'facts') {
          eventBus.emit({ ...base, factResult: phaseResult as FactValidationResult | null });
        } else if (phase === 'review') {
          eventBus.emit({ ...base, reviewResult: phaseResult as TaskReviewResult | null });
        } else if (phase === 'advisory') {
          eventBus.emit({
            ...base,
            advisoryResult: phaseResult as ValidationResult['advisoryBrowserQa'],
          });
        }
      },
      onReviewProgress: (progress: ReviewProgressSnapshot) => {
        eventBus.emit({
          type: 'pod.review_progress',
          timestamp: progress.updatedAt,
          podId,
          progress,
        });
      },
    };
  }

  function ownedValidationCallbacks(
    ownership: ReturnType<typeof captureValidationOwnership>,
    callbacks: Parameters<ValidationEngine['validate']>[3],
  ): NonNullable<Parameters<ValidationEngine['validate']>[3]> {
    return {
      onPhaseStarted: (...args) => {
        if (ownership.isCurrent()) callbacks?.onPhaseStarted?.(...args);
      },
      onPhaseCompleted: (...args) => {
        if (ownership.isCurrent()) callbacks?.onPhaseCompleted?.(...args);
      },
      onReviewProgress: (...args) => {
        if (ownership.isCurrent()) callbacks?.onReviewProgress?.(...args);
      },
    };
  }

  return { buildPhaseEventCallbacks, ownedValidationCallbacks };
}

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
  ValidationResult,
} from '@autopod/shared';
import type {
  ValidationEngine,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import type { EventBus } from './event-bus.js';
import type { captureValidationOwnership } from './validation-ownership.js';

interface ValidationProgressDependencies {
  eventBus: Pick<EventBus, 'emit'>;
}
type PhaseEventCallbacks = Required<ValidationPhaseCallbacks>;

export function createValidationProgress(deps: ValidationProgressDependencies): {
  buildPhaseEventCallbacks(podId: string): PhaseEventCallbacks;
  ownedValidationCallbacks(
    ownership: ReturnType<typeof captureValidationOwnership>,
    callbacks: Parameters<ValidationEngine['validate']>[3],
  ): NonNullable<Parameters<ValidationEngine['validate']>[3]>;
} {
  const { eventBus } = deps;

  /** Per-phase WebSocket events that drive the desktop Validation tab chips.
   *  Pass to every `validationEngine.validate()` call — the engine no-ops on
   *  missing callbacks, which silently freezes the UI. */
  function buildPhaseEventCallbacks(podId: string) {
    return {
      onPhaseStarted: (phase: ValidationPhase) => {
        eventBus.emit({
          type: 'pod.validation_phase_started',
          timestamp: new Date().toISOString(),
          podId,
          phase,
        });
      },
      onPhaseCompleted: (
        phase: ValidationPhase,
        status: 'pass' | 'fail' | 'skip' | 'pending_human',
        phaseResult: unknown,
      ) => {
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

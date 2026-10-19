import type { Pod, PodOptions } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

interface ValidationAttemptStartDependencies {
  assertGuidanceCollected(podId: string): void;
  runPushCheckpointScan(pod: Pod, profile: PodExecutionSettings): Promise<void>;
  podRepo: Pick<PodRepository, 'update'>;
  transition(pod: Pod, to: 'validating'): Pod;
  eventBus: Pick<EventBus, 'emit'>;
  getPodValidationSuite(pod: Pod): NonNullable<PodOptions['validationSuite']>;
  emitActivityStatus(podId: string, message: string): void;
}

interface ValidationAttemptStart {
  s1: Pod;
  attempt: number;
  validationSuite: NonNullable<PodOptions['validationSuite']>;
}

/** Start an ordinary validation attempt with the existing guards and accounting. */
export function createValidationAttemptStart(deps: ValidationAttemptStartDependencies): {
  startValidationAttempt(
    pod: Pod,
    profile: PodExecutionSettings,
    fromTerminal: boolean,
  ): Promise<ValidationAttemptStart>;
} {
  const {
    assertGuidanceCollected,
    runPushCheckpointScan,
    podRepo,
    transition,
    eventBus,
    getPodValidationSuite,
    emitActivityStatus,
  } = deps;

  async function startValidationAttempt(
    pod: Pod,
    profile: PodExecutionSettings,
    fromTerminal: boolean,
  ): Promise<ValidationAttemptStart> {
    const podId = pod.id;
    assertGuidanceCollected(podId);

    // Pre-push security scan: inspect the diff for secrets / PII / injection
    // before running validation. block decision throws and the pod's outer
    // error handler transitions to failed; warn / escalate findings ride
    // along into the PR body via scanRepo lookup at PR creation time.
    await runPushCheckpointScan(pod, profile);

    // Reset attempt counter when re-validating from a terminal/failed/validated state
    if (fromTerminal) {
      podRepo.update(podId, { validationAttempts: 0 });
    }

    const s1 = transition(pod, 'validating');

    // Wake-recovery: don't burn a validation attempt for the involuntary restart.
    // The flag is one-shot — clear it so subsequent attempts in the same run increment normally.
    const isWakeRecovery = s1.lastRecoveryTrigger === 'wake';
    const attempt = isWakeRecovery
      ? s1.validationAttempts
      : (fromTerminal ? 0 : s1.validationAttempts) + 1;
    podRepo.update(podId, {
      ...(isWakeRecovery ? { lastRecoveryTrigger: null } : { validationAttempts: attempt }),
    });

    eventBus.emit({
      type: 'pod.validation_started',
      timestamp: new Date().toISOString(),
      podId,
      attempt,
    });

    const reworkLabel = s1.reworkCount > 0 ? `rework ${s1.reworkCount}, ` : '';
    const validationSuite = getPodValidationSuite(s1);
    emitActivityStatus(
      podId,
      `Starting ${validationSuite} validation (${reworkLabel}attempt ${attempt}/${s1.maxValidationAttempts})…`,
    );

    return { s1, attempt, validationSuite };
  }

  return { startValidationAttempt };
}

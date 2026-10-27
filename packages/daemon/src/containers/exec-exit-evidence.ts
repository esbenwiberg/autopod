import { AutopodError, type ValidationInfrastructureFailure } from '@autopod/shared';

export type ExecInterruption = NonNullable<ValidationInfrastructureFailure['execution']>;

/** An interruption and cleanup are separate from an observed command exit. */
export class ExecExitUnverifiedError extends AutopodError {
  constructor(readonly execution?: ExecInterruption) {
    super(
      execution
        ? `${execution.cause === 'timeout' ? `Execution timed out after ${execution.timeoutMs}ms` : 'Execution cancelled'}; cleanup ${execution.cleanup}. Command exit is unverified. Automatic retry blocked; reconcile termination before explicit validation Resume. Partial output may contain test failures.`
        : 'Streaming exec exit was not observed; verify termination before another execution.',
      'EXEC_EXIT_UNVERIFIED',
      409,
    );
  }
}

/** A transport failure is not an observed process exit, including nonzero exit. */
export function unverifiedExecExit(cause?: unknown, cancelled = false): AutopodError {
  const execution = (cause as { execution?: ExecInterruption } | undefined)?.execution;
  return new ExecExitUnverifiedError(
    execution ?? (cancelled ? { cause: 'cancelled', cleanup: 'unverified' } : undefined),
  );
}

export function isObservedExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

import { AutopodError, type ValidationInfrastructureFailure } from '@autopod/shared';

export type ExecInterruption = NonNullable<ValidationInfrastructureFailure['execution']>;

/** Construct only at a concrete adapter boundary before attempting target start.
 * This is evidence about the target, not an exit code or settlement of old work.
 */
export class ExecNotDispatchedError extends AutopodError {
  readonly nonDispatch: NonNullable<ValidationInfrastructureFailure['nonDispatch']>;

  constructor(
    boundary: NonNullable<ValidationInfrastructureFailure['nonDispatch']>['boundary'],
    readonly cause: unknown,
  ) {
    const underlying = cause as { code?: unknown; statusCode?: unknown } | null;
    super(
      `Sandbox target command was not dispatched (${boundary}): ${cause instanceof Error ? cause.message : String(cause)}`,
      'EXEC_NOT_DISPATCHED',
      typeof underlying?.statusCode === 'number' ? underlying.statusCode : 502,
    );
    this.nonDispatch = {
      provider: 'azure-sandbox',
      boundary,
      ...(typeof underlying?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(underlying.code)
        ? { causeCode: underlying.code }
        : {}),
    };
  }
}

/** An interruption and cleanup are separate from an observed command exit. */
export class ExecInterruptedError extends AutopodError {
  constructor(readonly execution?: ExecInterruption) {
    const budget = execution?.timeoutMs;
    const reason =
      execution?.cause === 'timeout'
        ? `Execution timed out${budget === undefined ? '' : ` after ${budget}ms`}`
        : 'Execution cancelled';
    const observed = execution?.observedExitCode;
    const outcome =
      observed === undefined
        ? 'Command exit is unverified.'
        : `Command exit observed with code ${observed}; required validation is incomplete.`;
    super(
      execution
        ? `${reason}; cleanup ${execution.cleanup}. ${outcome} Automatic retry blocked; reconcile termination before explicit validation Resume. Partial output may contain test failures.`
        : 'Streaming exec exit was not observed; verify termination before another execution.',
      observed === undefined ? 'EXEC_EXIT_UNVERIFIED' : 'EXEC_INTERRUPTED',
      409,
    );
  }
}

/** A transport failure is not an observed process exit, including nonzero exit. */
export function unverifiedExecExit(cause?: unknown, cancelled = false): AutopodError {
  const execution = (cause as { execution?: ExecInterruption } | undefined)?.execution;
  return new ExecInterruptedError(
    execution ?? (cancelled ? { cause: 'cancelled', cleanup: 'unverified' } : undefined),
  );
}

export function isObservedExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

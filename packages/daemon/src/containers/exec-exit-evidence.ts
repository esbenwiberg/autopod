import { AutopodError } from '@autopod/shared';

/** A transport failure is not an observed process exit, including nonzero exit. */
export function unverifiedExecExit(): AutopodError {
  return new AutopodError(
    'Streaming exec exit was not observed; verify termination before another execution.',
    'EXEC_EXIT_UNVERIFIED',
    409,
  );
}

export function isObservedExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

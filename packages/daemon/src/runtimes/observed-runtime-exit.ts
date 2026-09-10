import { type AgentEvent, AutopodError } from '@autopod/shared';
import { isObservedExitCode } from '../containers/exec-exit-evidence.js';
import { type BoundedExitCodeOptions, awaitExitCodeBounded } from './stream-grace.js';

/** Finite CLI invocations must settle their process even when a consumer stops reading. */
export async function* withObservedRuntimeExit(
  source: AsyncIterable<AgentEvent>,
  exitCode: Promise<number>,
  options: BoundedExitCodeOptions,
): AsyncGenerator<AgentEvent, number> {
  // A backend can reject before the stream drains. Retain that rejection for the
  // bounded check without allowing an unhandled rejection to kill the daemon.
  void exitCode.catch(() => {});
  let observedCode: number | undefined;
  try {
    yield* source;
  } finally {
    const observed = await awaitExitCodeBounded(exitCode, options).catch(() => null);
    if (!observed || observed.timedOut || !isObservedExitCode(observed.code))
      // biome-ignore lint/correctness/noUnsafeFinally: Cancellation cannot release a finite process without observed exit evidence.
      throw new AutopodError(
        `${options.runtimeName} execution termination is unverified; retain output, source and resources before another execution.`,
        'EXEC_EXIT_UNVERIFIED',
        409,
      );
    observedCode = observed.code;
  }
  return observedCode;
}

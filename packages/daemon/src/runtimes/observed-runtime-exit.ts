import { type AgentEvent, AutopodError } from '@autopod/shared';
import { isObservedExitCode } from '../containers/exec-exit-evidence.js';
import {
  awaitExitCodeBounded,
  type BoundedExitCodeOptions,
  type BoundedExitCodeResult,
} from './stream-grace.js';

const DEFAULT_TERMINATION_TIMEOUT_MS = 30_000;

export interface ObservedRuntimeExitOptions extends BoundedExitCodeOptions {
  /**
   * Verified termination of the CLI and every process it started
   * (`StreamingExecResult.kill`). Used only when the exit was not observed
   * within the bounded wait — e.g. the agent ended its turn while background
   * tool processes kept the CLI alive, or the consumer stopped reading. Both
   * the verified kill and an exit observed afterwards are required; neither
   * alone is accepted as termination evidence.
   */
  terminate?: () => Promise<void>;
  /**
   * Ceiling for `terminate()` and, separately, for observing the exit after it.
   * Falls back to `AUTOPOD_RUNTIME_TERMINATION_TIMEOUT_MS`, then 30 s.
   */
  terminationTimeoutMs?: number;
  /** Called once when the daemon had to terminate the process to observe its exit. */
  onTerminated?: () => void;
}

/** Finite CLI invocations must settle their process even when a consumer stops reading. */
export async function* withObservedRuntimeExit(
  source: AsyncIterable<AgentEvent>,
  exitCode: Promise<number>,
  options: ObservedRuntimeExitOptions,
): AsyncGenerator<AgentEvent, number> {
  // A backend can reject before the stream drains. Retain that rejection for the
  // bounded check without allowing an unhandled rejection to kill the daemon.
  void exitCode.catch(() => {});
  let observedCode: number | undefined;
  try {
    yield* source;
  } finally {
    let observed = await awaitExitCodeBounded(exitCode, options).catch(() => null);
    if (!isObservedExit(observed) && options.terminate) {
      observed = await terminateAndObserve(exitCode, options);
    }
    if (!isObservedExit(observed))
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

function isObservedExit(
  observed: BoundedExitCodeResult | null,
): observed is BoundedExitCodeResult & { code: number } {
  return !!observed && !observed.timedOut && isObservedExitCode(observed.code);
}

async function terminateAndObserve(
  exitCode: Promise<number>,
  options: ObservedRuntimeExitOptions & { terminate: () => Promise<void> },
): Promise<BoundedExitCodeResult | null> {
  const timeoutMs = resolveTerminationTimeoutMs(options.terminationTimeoutMs);
  options.logger.warn(
    { component: options.runtimeName, podId: options.podId, timeoutMs },
    'Runtime exit not observed — terminating the CLI process tree before observing its exit',
  );
  options.onTerminated?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const termination = options.terminate().then(
    () => 'terminated' as const,
    (err: unknown) => {
      options.logger.warn(
        { component: options.runtimeName, podId: options.podId, err },
        'CLI process tree termination was not verified',
      );
      return 'failed' as const;
    },
  );
  const outcome = await Promise.race([
    termination,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (outcome === 'timeout')
    options.logger.warn(
      { component: options.runtimeName, podId: options.podId, timeoutMs },
      'CLI process tree termination did not settle within its timeout',
    );
  // Both are required: the leader's observed exit, and verification that no
  // process it started survived (an exited leader alone could leave the
  // background children that blocked its exit running).
  if (outcome !== 'terminated') return null;
  return awaitExitCodeBounded(exitCode, { ...options, timeoutMs }).catch(() => null);
}

function resolveTerminationTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const parsed = Number(process.env.AUTOPOD_RUNTIME_TERMINATION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TERMINATION_TIMEOUT_MS;
}

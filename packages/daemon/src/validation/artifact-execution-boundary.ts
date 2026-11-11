import { AutopodError } from '@autopod/shared';
import { ExecInterruptedError, isObservedExitCode } from '../containers/exec-exit-evidence.js';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';

/** Per-validation fence: a swallowed helper error cannot authorize another
 * command or paid review. Preserve backend receivers (including private fields).
 */
export function createArtifactExecutionBoundary(
  target: ContainerManager,
  assertSourceCurrent?: () => void,
) {
  let uncertain: AutopodError | undefined;
  const assertVerified = () => {
    if (uncertain) throw uncertain;
    assertSourceCurrent?.();
  };
  const execInContainer = async (id: string, command: string[], options?: ExecOptions) => {
    assertVerified();
    try {
      const result = await target.execInContainer(id, command, {
        ...options,
        requireObservedExit: true,
        assertCurrent: () => {
          assertVerified();
          options?.assertCurrent?.();
        },
      });
      if (!isObservedExitCode(result.exitCode))
        throw new AutopodError(
          'Buffered artifact exit was not observed',
          'EXEC_EXIT_UNVERIFIED',
          409,
        );
      return result;
    } catch (error) {
      if (
        error instanceof ExecInterruptedError &&
        error.execution?.cleanup === 'verified' &&
        isObservedExitCode(error.execution.observedExitCode)
      )
        throw error;
      uncertain ??=
        error instanceof ExecInterruptedError ||
        (error instanceof AutopodError && error.code === 'EXEC_EXIT_UNVERIFIED')
          ? error
          : Object.assign(
              new AutopodError(
                `Buffered artifact execution has unverified termination: ${error instanceof Error ? error.message : String(error)}`,
                'EXEC_EXIT_UNVERIFIED',
                409,
              ),
              { partialOutput: (error as { partialOutput?: string } | null)?.partialOutput },
            );
      throw uncertain;
    }
  };
  const methods = new Map<PropertyKey, unknown>();
  const manager = new Proxy(target, {
    get(object, key) {
      if (key === 'execInContainer') return execInContainer;
      const value = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      if (!methods.has(key))
        methods.set(key, (...args: unknown[]) => {
          assertVerified();
          return Reflect.apply(value, object, args);
        });
      return methods.get(key);
    },
  });
  return { manager, assertVerified };
}

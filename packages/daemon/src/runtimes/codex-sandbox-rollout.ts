import type { ContainerManager } from '../interfaces/container-manager.js';

/** One invocation's coalesced, bounded snapshots. Late collectors cannot publish. */
export function createCodexSandboxRollout(options: {
  containerManager: ContainerManager;
  containerId: string;
  containerPath: string;
  hostPath: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  sessionId: () => string | undefined;
}) {
  let inFlight: Promise<void> | undefined;
  let shortenPending: ((timeoutMs: number) => void) | undefined;
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  return {
    assertCurrent,
    refresh(timeoutMs: number): Promise<void> {
      assertCurrent();
      if (inFlight) {
        shortenPending?.(timeoutMs);
        return inFlight;
      }
      const controller = new AbortController();
      const sessionId = options.sessionId();
      const assertSnapshotCurrent = () => {
        controller.signal.throwIfAborted();
        assertCurrent();
        if (options.sessionId() !== sessionId)
          throw new Error('Codex sandbox snapshot session was superseded');
      };
      const cancel = () => controller.abort(options.signal.reason);
      options.signal.addEventListener('abort', cancel, { once: true });
      const timeout = () => controller.abort(new Error('Codex sandbox snapshot timed out'));
      let expiresAt = Date.now() + timeoutMs;
      let timer = setTimeout(timeout, timeoutMs);
      shortenPending = (remainingMs) => {
        if (Date.now() + remainingMs >= expiresAt) return;
        expiresAt = Date.now() + remainingMs;
        clearTimeout(timer);
        timer = setTimeout(timeout, remainingMs);
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      });
      const extraction = Promise.resolve().then(() => {
        assertSnapshotCurrent();
        return options.containerManager.extractDirectoryFromContainer(
          options.containerId,
          options.containerPath,
          options.hostPath,
          undefined,
          { signal: controller.signal, assertCurrent: assertSnapshotCurrent },
        );
      });
      const pending = Promise.race([extraction, aborted])
        .then(() => assertSnapshotCurrent())
        .finally(() => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', cancel);
          controller.abort();
          if (inFlight === pending) {
            inFlight = undefined;
            shortenPending = undefined;
          }
        });
      inFlight = pending;
      return pending;
    },
  };
}

export type CodexSandboxRollout = ReturnType<typeof createCodexSandboxRollout>;

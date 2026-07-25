import type { Logger } from 'pino';

export interface PodQueue {
  enqueue(podId: string): void;
  /**
   * Request another queue pass for a pod that may currently be active. Unlike
   * enqueue(), an active ID is remembered and moved to the waiting queue only
   * after the current processor finally releases it.
   */
  requeueAfterCurrent(podId: string): void;
  /**
   * Operator-only: clear a stale `activeIds` entry whose `processPod` finally
   * never ran (e.g. uncaught throw above the try/finally, or a hot-reload that
   * dropped the closure). Caller must assert no `processPod` is running for
   * this id — kickPod gates on `pod.status === 'queued'`, which is unreachable
   * from a live processPod past the queued→provisioning transition.
   * Returns `true` if the entry was cleared, `false` if it wasn't present.
   */
  clearStuckEntry(podId: string): boolean;
  readonly pending: number;
  readonly processing: number;
  drain(): Promise<void>; // wait for all in-flight to complete
}

export function createPodQueue(
  maxConcurrency: number,
  processPod: (podId: string) => Promise<void>,
  logger: Logger,
): PodQueue {
  const queue: string[] = [];
  // Track pod IDs that are actively being processed. Combined with the waiting-queue
  // dedup, this prevents a concurrent second processPod() run from racing the first
  // and killing the pod when it fails the queued→provisioning state transition.
  const activeIds = new Set<string>();
  const deferredRequeues = new Set<string>();
  let activeCount = 0;
  let drainResolvers: (() => void)[] = [];

  function checkDrain() {
    if (activeCount === 0 && queue.length === 0) {
      for (const resolve of drainResolvers) resolve();
      drainResolvers = [];
    }
  }

  async function processNext() {
    if (activeCount >= maxConcurrency || queue.length === 0) return;

    const podId = queue.shift();
    if (!podId) return;
    activeCount++;
    activeIds.add(podId);
    logger.info({ podId, activeCount, queued: queue.length }, 'Processing pod');

    try {
      await processPod(podId);
    } catch (err) {
      logger.error({ err, podId }, 'Pod processing failed');
    } finally {
      activeCount--;
      activeIds.delete(podId);
      if (deferredRequeues.delete(podId) && !queue.includes(podId)) {
        queue.push(podId);
      }
      checkDrain();
      processNext(); // pick up next item
    }
  }

  return {
    enqueue(podId: string) {
      // Deduplicate: skip if the pod is already waiting in the queue OR actively
      // being processed. Without this, rapid double-clicks, concurrent API calls, or
      // a race between the reconciler and a user rework can enqueue the same pod
      // twice — the second processPod run would fail the queued→provisioning state
      // transition and the error handler would kill the pod.
      if (!queue.includes(podId) && !activeIds.has(podId)) {
        queue.push(podId);
      }
      processNext();
    },
    requeueAfterCurrent(podId: string) {
      if (activeIds.has(podId)) {
        deferredRequeues.add(podId);
      } else if (!queue.includes(podId)) {
        queue.push(podId);
      }
      processNext();
    },
    clearStuckEntry(podId: string) {
      if (!activeIds.has(podId)) return false;
      activeIds.delete(podId);
      activeCount = Math.max(0, activeCount - 1);
      logger.warn({ podId, activeCount }, 'Cleared stuck activeIds entry from pod queue');
      checkDrain();
      processNext();
      return true;
    },
    get pending() {
      return queue.length;
    },
    get processing() {
      return activeCount;
    },
    async drain() {
      if (activeCount === 0 && queue.length === 0) return;
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },
  };
}

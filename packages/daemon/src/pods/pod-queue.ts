import type { Logger } from 'pino';

export interface PodQueue {
  enqueue(podId: string): void;
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

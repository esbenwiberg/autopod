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
    logger.info({ podId, activeCount, queued: queue.length }, 'Processing pod');

    try {
      await processPod(podId);
    } catch (err) {
      logger.error({ err, podId }, 'Pod processing failed');
    } finally {
      activeCount--;
      checkDrain();
      processNext(); // pick up next item
    }
  }

  return {
    enqueue(podId: string) {
      queue.push(podId);
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

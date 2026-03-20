import type { Logger } from 'pino';

export interface SessionQueue {
  enqueue(sessionId: string): void;
  readonly pending: number;
  readonly processing: number;
  drain(): Promise<void>; // wait for all in-flight to complete
}

export function createSessionQueue(
  maxConcurrency: number,
  processSession: (sessionId: string) => Promise<void>,
  logger: Logger,
): SessionQueue {
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

    const sessionId = queue.shift();
    if (!sessionId) return;
    activeCount++;
    logger.info({ sessionId, activeCount, queued: queue.length }, 'Processing session');

    try {
      await processSession(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, 'Session processing failed');
    } finally {
      activeCount--;
      checkDrain();
      processNext(); // pick up next item
    }
  }

  return {
    enqueue(sessionId: string) {
      queue.push(sessionId);
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

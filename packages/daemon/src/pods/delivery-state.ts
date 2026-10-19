import type { Logger } from 'pino';
import { createDurablePrManagerFactory } from '../worktrees/durable-pr-manager.js';
import type { PodRepository } from './pod-repository.js';
import type { ValidationWorkflowDependencies } from './validation-workflow-ports.js';
export function createDeliveryProvider(
  rawPrManagerFactory: ValidationWorkflowDependencies['prManagerFactory'],
  podRepo: Pick<PodRepository, 'deliveryLedger'>,
) {
  const prManagerFactory =
    rawPrManagerFactory && podRepo.deliveryLedger
      ? createDurablePrManagerFactory(podRepo.deliveryLedger, rawPrManagerFactory)
      : rawPrManagerFactory;
  return { prManagerFactory };
}
import { MergeQueue } from '../worktrees/merge-queue.js';
export function createDeliveryMergeQueue() {
  const mergeQueue = new MergeQueue();
  return { mergeQueue };
}
import { createPollingCoordinator } from './polling-coordinator.js';
export function createDeliveryPollingState(logger: Logger) {
  const mergePolling = createPollingCoordinator((err, podId) =>
    logger.debug({ err, podId }, 'Merge polling operation failed'),
  );
  const DEFAULT_MERGE_POLL_INTERVAL_MS = 60_000;
  return { mergePolling, DEFAULT_MERGE_POLL_INTERVAL_MS };
}

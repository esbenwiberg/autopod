import { createHash } from 'node:crypto';
import { AutopodError, type Pod } from '@autopod/shared';

interface CompletionRequest {
  promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
  instructions?: string;
  skipAgent?: boolean;
}

/** In-process overlap protection; durable side-effect receipts remain separate. */
export function createInteractiveCompletionCoordinator<Result>() {
  const active = new Map<
    string,
    { generation: number; requestHash: string; promise: Promise<Result> }
  >();
  return (
    pod: Pick<Pod, 'id' | 'lifecycleGeneration'>,
    request: CompletionRequest | undefined,
    execute: () => Promise<Result>,
  ): Promise<Result> => {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          request?.promoteTo ?? null,
          request?.instructions ?? null,
          request?.skipAgent ?? false,
        ]),
      )
      .digest('hex');
    const pending = active.get(pod.id);
    if (pending) {
      if (pending.generation === pod.lifecycleGeneration && pending.requestHash === requestHash)
        return pending.promise;
      throw new AutopodError(
        'Another completion request is still settling for this workspace. Retry after it finishes.',
        'COMPLETION_IN_PROGRESS',
        409,
      );
    }
    const promise: Promise<Result> = Promise.resolve()
      .then(execute)
      .finally(() => {
        if (active.get(pod.id)?.promise === promise) active.delete(pod.id);
      });
    active.set(pod.id, { generation: pod.lifecycleGeneration, requestHash, promise });
    return promise;
  };
}

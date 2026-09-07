import { createHash } from 'node:crypto';
import type { Pod, TaskRetryIdentity } from '@autopod/shared';

/** Startup has no verified container environment yet. Requested settings are not
 * evidence that a failed environment changed; an unknown/nonretryable retry needs
 * a recorded override until actual relevant inputs can be measured. */
export function sandboxStartupRetryInput(pod: Pod): {
  identity: TaskRetryIdentity;
  bindingHash: string;
} {
  return {
    identity: {
      source: null,
      contract: null,
      commands: null,
      environment: null,
      implementation: null,
    },
    bindingHash: createHash('sha256')
      .update(
        JSON.stringify({
          runtime: pod.runtime,
          model: pod.model,
          provider: pod.providerIdSnapshot,
          account: pod.providerAccountIdSnapshot,
        }),
      )
      .digest('hex'),
  };
}

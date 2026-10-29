import { AuthError, type OperatorActor } from '@autopod/shared';
import { vi } from 'vitest';
import type { AuthModule } from '../interfaces/auth-module.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createTerminationReconciliation } from '../pods/termination-reconciliation.js';
import { createTestContext } from './mock-helpers.js';

export const RECOVERY_SANDBOX = '3932af0d-110e-44a0-b7e5-bb70419d123e';
export const RECOVERY_ACTOR: OperatorActor = {
  type: 'human',
  userId: 'operator-oid',
  displayName: 'Operator',
};
export const RECOVERY_REASON = 'Verified deletion before continuing preserved work';

export function terminationAuth(): AuthModule {
  return {
    validateToken: async (token) => {
      if (token !== 'human-token') throw new AuthError('Invalid human token');
      return {
        oid: 'operator-oid',
        preferred_username: 'operator',
        name: 'Operator',
        roles: ['admin'],
        aud: 'autopod',
        iss: 'test',
        exp: 9999999999,
        iat: 1,
      };
    },
  };
}

export function terminationFixture() {
  const ctx = createTestContext();
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Recover interrupted work' },
    'operator',
  );
  ctx.podRepo.update(pod.id, { executionTarget: 'sandbox', containerId: RECOVERY_SANDBOX });
  const ledger = ctx.podRepo.taskExecutions;
  if (!ledger) throw new Error('Missing ledger');
  const runId = ledger.beginRun(pod.id, pod.lifecycleGeneration, 1, {
    runtime: pod.runtime,
    model: pod.model,
    providerAccountId: null,
    resource: { containerId: RECOVERY_SANDBOX, executionTarget: 'sandbox' },
  });
  ledger.retainUnverifiedRun(runId);
  // Mimic the error path after preservation and backend deletion, but before reconciliation.
  ctx.podRepo.update(pod.id, {
    status: 'failed',
    containerId: null,
    worktreePath: '/tmp/retained-source',
  });
  vi.mocked(ctx.containerManager.getStatus).mockResolvedValue('deleted');
  const emitActivityStatus = vi.fn();
  const isAgentActive = vi.fn(() => false);
  const service = createTerminationReconciliation({
    podRepo: ctx.podRepo,
    getContainerManager: () => ctx.containerManager,
    emitActivityStatus,
    isAgentActive,
  });
  return {
    ...ctx,
    manager,
    podId: pod.id,
    runId,
    ledger,
    service,
    emitActivityStatus,
    isAgentActive,
  };
}

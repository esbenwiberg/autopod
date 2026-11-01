import { vi } from 'vitest';
import type { SandboxRecoveryRequest } from '../containers/sandbox-recovery-journal.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { createSandboxRecovery } from '../pods/sandbox-recovery.js';
import { assertSourceResourceReleasable } from '../pods/source-custody-guards.js';
import { createFailingValidationResult } from './mock-helpers.js';
import { createOperatorFixture } from './operator-helpers.js';
import { retainTestWakeup } from './sandbox-wakeup-helpers.js';

export function sandboxRecoveryFixture(pending = true, disk = false, containerId?: string) {
  const f = createOperatorFixture(disk, 'sandbox');
  f.mainCaptured.transition(f.pod(), 'failed');
  if (containerId) {
    f.podRepo.update('prepare', { containerId: null });
    f.podRepo.update('prepare', { containerId });
  }
  const id = f.pod().containerId;
  const journal = f.podRepo.sandboxWakeups;
  const sourceAdoptions = f.podRepo.sourceAdoptions;
  const taskExecutions = f.podRepo.taskExecutions;
  if (!id || !journal || !sourceAdoptions || !taskExecutions)
    throw new Error('Incomplete recovery fixture');
  const key = `https://example.invalid/sandboxes/${id}`;
  journal.observeRunning(key, id);
  if (pending) retainTestWakeup(f.podRepo, id);
  let state: Awaited<ReturnType<ContainerManager['getStatus']>> = 'stopped';
  const cm = {
    ...f.cm,
    executionResourceScope: 'test-scope',
    getResourceKey: vi.fn(async () => key),
    getStatus: vi.fn<ContainerManager['getStatus']>(async () => {
      if (state === 'running') journal.observeRunning(key, id);
      return state;
    }),
    start: vi.fn<ContainerManager['start']>(async (_id, options) => {
      options?.assertCurrent?.();
      journal.recovery.assertWakeable(id);
      const intent = journal.claim(key, id, 'prepare');
      if (!intent.acquired) throw new Error('Unknown resume must not be replayed');
      journal.beginDispatch(intent.id);
      state = 'running';
      journal.observeRunning(key, id);
    }),
    kill: vi.fn<ContainerManager['kill']>(async () => {
      journal.assertReleasable(id);
      state = 'deleted';
    }),
  } satisfies ContainerManager;
  const deleteSession = vi.fn(async (podId: string) => {
    f.podRepo.delete(podId);
  });
  let idle = true;
  const deps = {
    podRepo: f.podRepo,
    getContainerManager: () => cm,
    isIdle: () => idle,
    isGoal: () => false,
    deleteSession,
  };
  const recovery = createSandboxRecovery(deps);
  const input: SandboxRecoveryRequest = {
    id: 'human-decision',
    action: 'abandon',
    sandboxId: id,
    expectedGeneration: f.pod().lifecycleGeneration,
    expectedResourceKey: key,
    reason: 'Discard this retained sandbox and its unpreserved reports',
    acknowledgeDataLoss: true,
  };
  return {
    ...f,
    journal,
    sourceAdoptions,
    taskExecutions,
    cm,
    recovery,
    deps,
    input,
    key,
    sandboxId: id,
    actor: { type: 'human' as const, userId: 'operator-human' },
    setState: (value: typeof state) => {
      state = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    deleteSession,
  };
}

export function sandboxValidationAbandonmentFixture(disk = false) {
  const f = sandboxRecoveryFixture(false, disk, '11111111-1111-4111-8111-111111111111');
  const validations = f.podRepo.validationExecutions;
  const retries = f.podRepo.taskRetries;
  if (!validations || !retries) throw new Error('Missing validation fixture ledgers');
  const pod = f.pod();
  const admission = retries.admit(
    pod.id,
    pod.lifecycleGeneration,
    {
      source: 'a'.repeat(64),
      contract: 'b'.repeat(64),
      commands: 'c'.repeat(64),
      environment: null,
      implementation: null,
    },
    'd'.repeat(64),
    [],
  );
  retries.start(admission.id);
  const dispatch = validations.dispatch(pod, admission.id, 1, f.cm.executionResourceScope);
  if (!dispatch) throw new Error('Missing immutable validation dispatch');
  const result = {
    ...createFailingValidationResult(pod.id),
    executionDispatchId: dispatch,
    infrastructureFailure: {
      phase: 'test' as const,
      code: 'EXEC_EXIT_UNVERIFIED',
      message: 'Original test exit remains unknown',
      retryable: false,
    },
  };
  validations.recordResult(result, dispatch);
  retries.finish(admission.id, 'nonretryable', 10);
  f.podRepo.update(pod.id, { lastValidationResult: result });
  f.cm.kill.mockImplementation(async () => {
    assertSourceResourceReleasable(f.db, f.sandboxId);
    f.journal.assertReleasable(f.sandboxId);
    f.setState('deleted');
  });
  return { ...f, validations, retries, admission, dispatch, result };
}

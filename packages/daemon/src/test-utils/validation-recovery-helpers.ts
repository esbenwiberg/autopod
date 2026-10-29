import { vi } from 'vitest';
import { createPodManager } from '../pods/pod-manager.js';
import { createFailingValidationResult, createTestContext } from './mock-helpers.js';

export function validationRecoveryFixture() {
  const ctx = createTestContext();
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Recover failed checks' },
    'operator',
  );
  const result = createFailingValidationResult(pod.id);
  result.timestamp = '2026-10-27T17:18:10.000Z';
  ctx.podRepo.update(pod.id, {
    status: 'failed',
    worktreePath: '/tmp/retained-source',
    containerId: 'retained-container',
    lastValidationResult: result,
  });
  const revalidate = vi
    .spyOn(manager, 'revalidateSession')
    .mockResolvedValue({ newCommits: false, result: 'pass' });
  const repair = vi.spyOn(manager, 'triggerValidation').mockResolvedValue();
  return {
    ...ctx,
    manager,
    podId: pod.id,
    result,
    revalidate,
    repair,
    input: {
      expectedGeneration: pod.lifecycleGeneration,
      expectedValidationTimestamp: result.timestamp,
    },
  };
}

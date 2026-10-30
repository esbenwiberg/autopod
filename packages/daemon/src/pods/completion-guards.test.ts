import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompletionFixture } from '../test-utils/completion-helpers.js';
const fixtures: ReturnType<typeof createCompletionFixture>[] = [];
function fixture(disk = false) {
  const f = createCompletionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('completion guards', () => {
  it('consults validation settlement before allowing completion', () => {
    const f = fixture();
    const validations = f.podRepo.validationExecutions;
    if (!validations) throw new Error('Missing real validation ledger fixture');
    const failure = new Error('Validation execution remains unsettled');
    const settlement = vi.spyOn(validations, 'assertTaskSettled').mockImplementation(() => {
      throw failure;
    });
    expect(() => f.guards.assertExecutionTerminationVerified('prepare')).toThrow(failure);
    expect(settlement).toHaveBeenCalledExactlyOnceWith('prepare');
  });
  it('checks generation and optional container identity using the original repository', () => {
    const f = fixture();
    f.running();
    const pod = f.pod();
    expect(f.guards.ownsLifecycle('prepare', pod.lifecycleGeneration, pod.containerId)).toBe(true);
    expect(f.guards.ownsLifecycle('prepare', pod.lifecycleGeneration, null)).toBe(true);
    expect(f.guards.ownsLifecycle('prepare', pod.lifecycleGeneration, 'replacement')).toBe(false);
    expect(f.guards.ownsLifecycle('prepare', pod.lifecycleGeneration + 1, null)).toBe(false);
    expect(() => f.guards.ownsLifecycle('missing', 1, null)).toThrow();
  });
  it('rejects actual pending guidance without consuming it', () => {
    const f = fixture();
    f.deps.nudgeRepo.queue('prepare', 'Saved guidance');
    expect(() => f.guards.assertGuidanceCollected('prepare')).toThrow(
      expect.objectContaining({ code: 'UNCOLLECTED_HUMAN_GUIDANCE' }),
    );
    expect(f.deps.nudgeRepo.listPending('prepare')).toMatchObject([
      { message: 'Saved guidance', consumed: false },
    ]);
  });
  it('checks deletion ownership before task termination and retains original error identity', () => {
    const f = fixture();
    const ownership = f.podRepo.deletionOwnership;
    const tasks = f.podRepo.taskExecutions;
    if (!ownership || !tasks) throw new Error('Missing real ledger fixture');
    const failure = new Error('Deletion is owned');
    const deletion = vi.spyOn(ownership, 'assertTaskAvailable').mockImplementation(() => {
      throw failure;
    });
    const termination = vi.spyOn(tasks, 'hasUnverifiedTermination');
    expect(() => f.guards.assertExecutionTerminationVerified('prepare')).toThrow(failure);
    expect(deletion).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(termination).not.toHaveBeenCalled();
  });
});

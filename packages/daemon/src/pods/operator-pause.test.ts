import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';

function blockedFixture() {
  const f = createOperatorFixture();
  f.deps.escalationRepo.insert({
    id: 'pause-infrastructure',
    podId: 'prepare',
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    response: null,
    payload: {
      kind: 'infrastructure',
      lifecycleGeneration: f.pod().lifecycleGeneration,
      requiresResponse: false,
      description: 'Configured runner unavailable',
      attempted: ['configured check'],
      needs: 'Qualified execution',
    },
  });
  return f;
}
describe('pause settlement ownership', () => {
  it('retains its admission fence until the narrow infrastructure owner settles', async () => {
    const f = blockedFixture();
    const run = f.activeRun();
    let release!: () => void;
    const preservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.pauseCaptured.reconcileInfrastructureBlocker).mockReturnValueOnce(preservation);
    const owner = f.pause();
    const pending = owner.pauseSession('prepare');
    await Promise.resolve();
    expect(f.pauseCaptured.reconcileInfrastructureBlocker).not.toHaveBeenCalled();
    run.settle();
    await vi.waitFor(() =>
      expect(f.pauseCaptured.reconcileInfrastructureBlocker).toHaveBeenCalledWith('prepare'),
    );
    expect(f.pod().status).toBe('running');
    expect(f.state.pauseIntents.has('prepare')).toBe(true);
    await expect(owner.pauseSession('prepare')).rejects.toMatchObject({ code: 'PAUSE_SETTLING' });
    await expect(f.messages().sendMessage.call(f.calls, 'prepare', 'Resume')).rejects.toMatchObject(
      { code: 'PAUSE_SETTLING' },
    );
    release();
    await pending;
    // A narrow owner that declines finalization is not permission to park anyway.
    expect(f.pod().status).toBe('running');
    expect(f.state.pauseIntents.size).toBe(0);
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
    expect(f.calls.approveSession).not.toHaveBeenCalled();
    expect(f.ctx.runtime.suspend).toHaveBeenCalledTimes(1);
  });
  it('propagates narrow-owner failure without parking or retaining its pause token', async () => {
    const f = blockedFixture();
    const failure = new Error('Infrastructure ownership read failed');
    vi.mocked(f.pauseCaptured.reconcileInfrastructureBlocker).mockRejectedValueOnce(failure);
    await expect(f.pause().pauseSession('prepare')).rejects.toBe(failure);
    expect(f.pod().status).toBe('running');
    expect(f.state.pauseIntents.size).toBe(0);
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
  });
  it('does not clear a replacement pause token or overwrite a newer lifecycle after finalization', async () => {
    const f = blockedFixture();
    const token = Symbol('newer-pause');
    const generation = f.pod().lifecycleGeneration;
    vi.mocked(f.pauseCaptured.reconcileInfrastructureBlocker).mockImplementationOnce(async () => {
      f.state.pauseIntents.set('prepare', token);
      f.podRepo.incrementLifecycleGeneration('prepare');
    });
    const emit = vi.spyOn(f.pauseCaptured, 'emitActivityStatus');
    await f.pause().pauseSession('prepare');
    expect(f.state.pauseIntents.get('prepare')).toBe(token);
    expect(f.pod()).toMatchObject({ status: 'running', lifecycleGeneration: generation + 1 });
    expect(emit).toHaveBeenCalledExactlyOnceWith('prepare', 'Pausing pod…');
  });
  it('suspends and waits for the original run before marking paused and clearing its timer', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    const run = f.activeRun();
    const pending = f.pause().pauseSession('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ctx.runtime.suspend).toHaveBeenCalledWith('prepare');
    expect(f.state.pauseIntents.has('prepare')).toBe(true);
    expect(f.pod().status).toBe('running');
    run.settle();
    await pending;
    expect(f.pod()).toMatchObject({ status: 'paused', pauseReason: 'manual' });
    expect(f.state.pauseIntents.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains a real question that arrives while the stop is settling', async () => {
    const f = createOperatorFixture();
    const run = f.activeRun();
    const stopping = f.pause().pauseSession('prepare');
    const question = f.awaiting();
    expect(f.pod().status).toBe('awaiting_input');
    run.settle();
    await stopping;
    expect(f.pod()).toMatchObject({ status: 'awaiting_input', pendingEscalation: question });
    expect(f.state.pauseIntents.size).toBe(0);
  });
  it('retains running ownership when native termination is unknown and never repeats its stop', async () => {
    const f = createOperatorFixture();
    const ledger = f.podRepo.taskExecutions;
    if (!ledger) throw new Error('Missing task execution ledger');
    vi.spyOn(ledger, 'hasUnverifiedTermination').mockReturnValueOnce(false).mockReturnValue(true);
    const run = f.activeRun();
    const stopping = f.pause().pauseSession('prepare');
    run.settle();
    await expect(stopping).rejects.toMatchObject({ code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED' });
    expect(f.pod().status).toBe('running');
    expect(f.state.pauseIntents.size).toBe(0);
    await expect(f.pause().pauseSession('prepare')).rejects.toMatchObject({
      code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED',
    });
    expect(f.ctx.runtime.suspend).toHaveBeenCalledTimes(1);
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
  });
  it('blocks duplicate pause and message admission while settlement is outstanding', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    const run = f.activeRun();
    const pending = f.pause().pauseSession('prepare');
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.pause().pauseSession('prepare')).rejects.toMatchObject({
      code: 'PAUSE_SETTLING',
    });
    await expect(f.messages().sendMessage.call(f.calls, 'prepare', 'Resume')).rejects.toMatchObject(
      { code: 'PAUSE_SETTLING' },
    );
    run.settle();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for a replacement run within the same deadline', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    const first = f.activeRun();
    const pending = f.pause().pauseSession('prepare');
    await vi.advanceTimersByTimeAsync(0);
    const second = f.activeRun();
    first.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('running');
    second.settle();
    await pending;
    expect(f.pod().status).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out at ten seconds and releases only its own token when the old run later settles', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    const run = f.activeRun();
    const pending = f.pause().pauseSession('prepare');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PAUSE_QUIESCENCE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(f.pod().status).toBe('running');
    expect(f.state.pauseIntents.has('prepare')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const replacement = Symbol('replacement');
    f.state.pauseIntents.set('prepare', replacement);
    run.settle();
    await Promise.resolve();
    expect(f.state.pauseIntents.get('prepare')).toBe(replacement);
  });
  it('retains a failed suspend intent until settlement and then allows retry', async () => {
    const f = createOperatorFixture();
    const run = f.activeRun();
    const failure = new Error('Synthetic suspend');
    vi.mocked(f.ctx.runtime.suspend).mockRejectedValueOnce(failure);
    await expect(f.pause().pauseSession('prepare')).rejects.toBe(failure);
    expect(f.state.pauseIntents.has('prepare')).toBe(true);
    run.settle();
    await Promise.resolve();
    expect(f.state.pauseIntents.has('prepare')).toBe(false);
  });
  it('reads live native Goal control after owner construction', async () => {
    const f = createOperatorFixture();
    const owner = f.pause();
    const goal = await f.goal();
    await owner.pauseSession('prepare');
    expect(goal.control).toHaveBeenCalledWith('prepare', 'pause');
    expect(f.ctx.runtime.suspend).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('paused');
  });
});

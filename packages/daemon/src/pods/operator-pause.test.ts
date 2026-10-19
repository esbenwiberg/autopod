import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
describe('pause settlement ownership', () => {
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

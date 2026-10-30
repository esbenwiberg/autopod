import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
describe('operator kill lifetime and fences', () => {
  it('rechecks validation evidence after asynchronous cleanup before deleting source', async () => {
    const f = createOperatorFixture();
    const report = path.join(f.directory, 'retained-failed-validation.txt');
    await writeFile(report, 'partial assertion output');
    vi.mocked(f.worktreeManager.cleanup).mockImplementation(async () => {
      await rm(report);
    });
    const ledger = f.podRepo.validationExecutions;
    if (!ledger) throw new Error('Missing validation ledger');
    const check = vi.spyOn(ledger, 'assertTaskSettled');
    f.killCaptured.killSidecarsForPod = vi.fn(async () => {
      await writeFile(report, 'late failed assertion');
      check.mockImplementation(() => {
        throw new Error('Late unknown validation outcome');
      });
    });
    await expect(f.kill().killSession('prepare')).rejects.toThrow(
      'Late unknown validation outcome',
    );
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
    expect(await readFile(report, 'utf8')).toBe('late failed assertion');
  });
  it('aborts validation, performs cleanup and closes the live provider attempt before persisted killed history survives reopen', async () => {
    const f = createOperatorFixture(true);
    const owner = f.kill();
    f.nativeAttempts.ensureProviderAttempt(f.pod(), f.passContext().profile);
    f.live.providerAttemptRepo = f.repo;
    const controller = new AbortController();
    f.killCaptured.validationAbortControllers.set('prepare', controller);
    await owner.killSession('prepare');
    expect(controller.signal.aborted).toBe(true);
    expect(f.cm.kill).toHaveBeenCalledWith('container-123');
    expect(f.killCaptured.killSidecarsForPod).toHaveBeenCalledWith('prepare');
    expect(f.killCaptured.destroyPodNetwork).toHaveBeenCalledWith('prepare');
    expect(f.ctx.runtime.abort).toHaveBeenCalledWith('prepare');
    expect(f.repo.list('prepare')[0]?.outcome).toBe('aborted');
    expect(f.pod()).toMatchObject({ status: 'killed', containerId: null, worktreePath: null });
    const saved = f.pod();
    const history = f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare');
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare')).toEqual(
      history,
    );
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('preserves preliminary preview/poller effects before rejecting an ineligible status', async () => {
    const f = createOperatorFixture();
    const effects: string[] = [];
    f.killCaptured.clearPreviewTimer = vi.fn(() => {
      effects.push('clear');
    });
    f.killCaptured.stopSandboxPreviewProxy = async () => {
      effects.push('proxy');
    };
    f.killCaptured.stopMergePolling = vi.fn(() => {
      effects.push('merge');
    });
    f.podRepo.update('prepare', { status: 'complete' });
    await expect(f.kill().killSession('prepare')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(effects).toEqual(['clear', 'proxy', 'merge']);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('retains a replacement generation and never cleans its container after an in-flight cleanup callback', async () => {
    const f = createOperatorFixture();
    f.killCaptured.killSidecarsForPod = vi.fn(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
      f.podRepo.update('prepare', { status: 'running', containerId: 'replacement' });
    });
    await f.kill().killSession('prepare');
    expect(f.pod()).toMatchObject({ status: 'running', containerId: 'replacement' });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.killCaptured.forgetMaxCredentialLineage).not.toHaveBeenCalled();
  });
  it('times out cleanup at thirty seconds and generation-fences its late continuation', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.killCaptured.killSidecarsForPod = vi.fn(async () => {
      await gate;
    });
    const pending = f.kill().killSession('prepare');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(f.pod()).toMatchObject({
      status: 'killed',
      containerId: 'container-123',
      worktreePath: f.directory,
    });
    expect(vi.getTimerCount()).toBe(0);
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { status: 'running', containerId: 'replacement' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('replacement');
  });
  it('uses live native Goal cancel before ordinary cleanup', async () => {
    const f = createOperatorFixture();
    const owner = f.kill();
    const goal = await f.goal();
    await owner.killSession('prepare');
    expect(goal.control).toHaveBeenCalledWith('prepare', 'cancel');
    expect(f.pod().status).toBe('killed');
  });
});

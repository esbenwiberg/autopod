import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace read-only artifact observation', () => {
  it('returns unavailable with missing evidence or pending guidance and never resumes', () => {
    const f = createWorkspaceFixture();
    const owner = f.observation();
    f.live.eventRepo = undefined;
    expect(owner.getArtifactResumeObservation('prepare')).toEqual({
      protocol: 'artifact-resume-observation-v1',
      state: 'unavailable',
      operations: [],
    });
    f.live.eventRepo = f.deps.eventRepo;
    f.deps.nudgeRepo.queue('prepare', 'Pending guidance');
    expect(owner.getArtifactResumeObservation('prepare').state).toBe('unavailable');
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('reads the live repository after construction and refuses active run authority', () => {
    const f = createWorkspaceFixture();
    const get = vi.spyOn(f.deps.eventRepo, 'getForSession');
    const owner = f.observation();
    owner.getArtifactResumeObservation('prepare');
    expect(get).toHaveBeenCalledWith('prepare');
    get.mockClear();
    const ledger = f.podRepo.taskExecutions;
    if (!ledger) throw new Error('Missing execution ledger');
    const pod = f.pod();
    const run = ledger.beginRun('prepare', pod.lifecycleGeneration, pod.finalization?.cycle ?? 0, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: 'account',
    });
    expect(owner.getArtifactResumeObservation('prepare').state).toBe('unavailable');
    expect(get).not.toHaveBeenCalled();
    ledger.finishRun(run, 'stopped', null);
  });
});

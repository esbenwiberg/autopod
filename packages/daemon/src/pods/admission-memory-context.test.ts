import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
import type { AdmissionMemoryCaptured } from './admission-contracts.js';
import { createAdmissionMemoryContext } from './admission-memory-context.js';
describe('launch memory context', () => {
  it('rejects unavailable executor and refuses a native missing frozen scope', () => {
    const f = createAdmissionFixture();
    const owner = createAdmissionMemoryContext(f.live, {
      getReviewerExecutor: () => undefined,
      getEffectiveReviewerConfig: () => ({
        profile: f.profiles.get('test-profile'),
        credentials: null,
      }),
    });
    expect(() => owner.getLaunchMemoryContext(f.pod())).toThrow('requires composable');
    expect(() =>
      owner.getProjectMemoryScope({ ...f.pod(), launchConfigDigest: 'missing' }),
    ).toThrow('frozen launch');
  });
  it('retains selected executor, exact prompt/timeout and stdout while reading live repository scope', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    const executor = vi.fn(async () => ({ stdout: 'ranking evidence' }));
    const captured: AdmissionMemoryCaptured = {
      getReviewerExecutor: () => executor,
      getEffectiveReviewerConfig: () => ({
        profile: f.profiles.get('test-profile'),
        credentials: null,
      }),
    };
    const owner = createAdmissionMemoryContext(
      { ...f.live, launchConfiguration: { read: () => n.config } },
      captured,
    );
    const context = owner.getLaunchMemoryContext({
      ...f.pod(),
      launchConfigDigest: n.config.digest,
    });
    captured.getReviewerExecutor = () => undefined;
    await expect(
      context.reviewer.generateText({ systemPrompt: 'system', userMessage: 'user', maxTokens: 99 }),
    ).resolves.toBe('ranking evidence');
    expect(executor).toHaveBeenCalledWith({ prompt: 'system\n\nuser', timeout: 20000 });
    expect(context.projectScope).toEqual({ scope: 'repository', id: 'repo-a', setupId: 'default' });
  });
});

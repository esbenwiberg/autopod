import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
import type { AdmissionCreateCalls } from './admission-contracts.js';
describe('analysis workspace admission', () => {
  it('encodes the complete history query and preserves creator on actual receiver', () => {
    const f = createAdmissionFixture();
    const createSession = vi.fn<AdmissionCreateCalls['createSession']>(() => f.pod());
    const creator = { name: 'Owner' };
    const query = { limit: 7 };
    const owner = f.analysis();
    owner.createHistoryWorkspace.call(
      { createSession },
      'test-profile',
      'operator',
      query,
      creator,
    );
    expect(createSession).toHaveBeenCalledWith(
      {
        profileName: 'test-profile',
        task: '[history] History analysis workspace | {"limit":7}',
        outputMode: 'workspace',
        skipValidation: true,
      },
      'operator',
      creator,
    );
  });
  it('reads live memory adapter and resolves the current createSession receiver', () => {
    const f = createAdmissionFixture();
    const owner = f.analysis();
    const list = vi.fn(() => []);
    f.live.memoryRepo = { list, listByScope: list };
    const old = vi.fn<AdmissionCreateCalls['createSession']>(() => f.pod());
    const replacement = vi.fn<AdmissionCreateCalls['createSession']>(() => f.pod());
    const calls = { createSession: old };
    calls.createSession = replacement;
    owner.createMemoryWorkspace.call(calls, 'test-profile', 'operator');
    expect(old).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.stringContaining('Review 0 memories') }),
      'operator',
      undefined,
    );
    expect(list).toHaveBeenCalledWith('global', true);
    expect(list).toHaveBeenCalledWith('profile', 'test-profile', true);
  });
  it('retains native legacy-API refusal for these original analysis helpers', async () => {
    const f = createAdmissionFixture();
    await f.native();
    const calls = { createSession: f.legacy().createSession };
    expect(() =>
      f.analysis().createMemoryWorkspace.call(calls, 'test-profile', 'operator'),
    ).toThrow('requires a resolved');
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
});

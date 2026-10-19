import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture, deferred } from '../test-utils/admission-queries-helpers.js';
import type { AdmissionSeriesCalls } from './admission-contracts.js';
describe('series deletion lifetime', () => {
  it('refuses missing series without invoking controls', async () => {
    const f = createAdmissionFixture();
    const calls = { killSession: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}) };
    await expect(f.series().deleteSeriesWithCascade.call(calls, 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(calls.killSession).not.toHaveBeenCalled();
    expect(calls.deleteSession).not.toHaveBeenCalled();
  });
  it('continues sequentially after kill and delete failure using receiver replacements after awaits', async () => {
    const f = createAdmissionFixture();
    f.insert('a', { seriesId: 's' });
    f.insert('b', { seriesId: 's', status: 'complete' });
    const gate = deferred();
    const effects: string[] = [];
    const first = vi.fn<AdmissionSeriesCalls['deleteSession']>(async () => {});
    const calls = {
      killSession: vi.fn<AdmissionSeriesCalls['killSession']>(async (id) => {
        effects.push(`kill ${id}`);
        await gate.promise;
        throw new Error('Synthetic kill');
      }),
      deleteSession: first,
    };
    const pending = f.series().deleteSeriesWithCascade.call(calls, 's');
    const replacement = vi.fn<AdmissionSeriesCalls['deleteSession']>(async (id) => {
      effects.push(`delete ${id}`);
      throw new Error('Synthetic delete');
    });
    calls.deleteSession = replacement;
    gate.resolve();
    await pending;
    expect(first).not.toHaveBeenCalled();
    expect(effects).toEqual(['kill a', 'delete a', 'delete b']);
    expect(replacement).toHaveBeenCalledTimes(2);
    expect(f.podRepo.getPodsBySeries('s')).toHaveLength(2);
  });
});

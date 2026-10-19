import type { ValidationOverride } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
import { mergeOverrides, warnIfSinglePrSeriesMissingSeriesMeta } from './admission-policy.js';
describe('admission metadata policy', () => {
  it('replaces finding values without changing first-key order or mutating inputs', () => {
    const old: ValidationOverride = {
      findingId: 'a',
      description: 'old',
      action: 'dismiss',
      createdAt: 'before',
    };
    const b = { ...old, findingId: 'b' };
    const newest = { ...old, description: 'latest' };
    const original = [old, b];
    expect(mergeOverrides(original, [newest])).toEqual([newest, b]);
    expect(original).toEqual([old, b]);
  });
  it('warns only for incomplete single-series metadata', () => {
    const f = createAdmissionFixture();
    const warn = vi.spyOn(f.deps.logger, 'warn');
    warnIfSinglePrSeriesMissingSeriesMeta(f.pod(), f.deps.logger);
    expect(warn).not.toHaveBeenCalled();
    const pod = { ...f.pod(), prMode: 'single' as const, seriesId: 's' };
    warnIfSinglePrSeriesMissingSeriesMeta(pod, f.deps.logger);
    expect(warn).toHaveBeenCalledOnce();
    warnIfSinglePrSeriesMissingSeriesMeta(
      { ...pod, seriesName: 'Title', seriesDescription: 'Purpose' },
      f.deps.logger,
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

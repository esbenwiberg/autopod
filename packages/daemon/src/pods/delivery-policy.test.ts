import { describe, expect, it } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import {
  formatRebaseConflictReason,
  isSinglePrSeriesPod,
  resolvePrBaseBranch,
} from './delivery-policy.js';
describe('delivery policy', () => {
  it('bounds conflict details and retains the empty diagnostic', () => {
    expect(formatRebaseConflictReason('main', [])).toBe('Rebase conflicts on main: (see logs)');
    expect(formatRebaseConflictReason('release', ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(
      'Rebase conflicts on release: a, b, c, d, e…',
    );
  });
  it('resolves a base distinct from the feature branch using the original fallbacks', () => {
    const f = createDeliveryFixture();
    const pod = f.pod();
    const profile = f.passContext().profile;
    expect(resolvePrBaseBranch({ ...pod, baseBranch: 'release' }, profile)).toBe('release');
    expect(resolvePrBaseBranch({ ...pod, branch: 'main', baseBranch: 'main' }, profile)).toBe(
      'main',
    );
    expect(
      resolvePrBaseBranch(
        { ...pod, branch: 'release', baseBranch: 'release' },
        { ...profile, defaultBranch: 'release' },
      ),
    ).toBe('main');
  });
  it('requires both single PR mode and series identity', () => {
    expect(isSinglePrSeriesPod({ prMode: 'single', seriesId: null })).toBe(false);
    expect(isSinglePrSeriesPod({ prMode: 'single', seriesId: 'series' })).toBe(true);
    expect(isSinglePrSeriesPod({ prMode: 'stacked', seriesId: 'series' })).toBe(false);
  });
});

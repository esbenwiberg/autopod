import type { ValidationResult } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
const fixtures: ReturnType<typeof createApprovalFixture>[] = [];
function fixture(disk = false) {
  const f = createApprovalFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('approval readiness ownership', () => {
  it('refreshes only original eligible statuses and retains best-effort failure behavior', () => {
    const f = fixture();
    const refresh = vi.spyOn(f.refresh.readinessService, 'refreshPodReadiness');
    expect(f.refresh.refreshReadiness('prepare')).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    f.validated();
    expect(f.refresh.refreshReadiness('prepare')).toBe(true);
    expect(refresh).toHaveBeenCalledWith('prepare', {});
    refresh.mockImplementationOnce(() => {
      throw new Error('Synthetic readiness failure');
    });
    expect(f.refresh.refreshReadiness('prepare')).toBe(false);
  });
  it('waits for the exact original advisory promise and refreshes after release', async () => {
    const f = fixture();
    f.validated();
    let finish: (result: ValidationResult) => void = () => {};
    const pending = new Promise<ValidationResult>((resolve) => {
      finish = resolve;
    });
    f.advisoryRuns.set('prepare', pending);
    const refresh = vi.spyOn(f.refresh.readinessService, 'refreshPodReadiness');
    let settled = false;
    const operation = f.context
      .resolveApprovalReadiness(f.pod(), { waitForAdvisory: true })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    const settledBeforeRelease = settled;
    const before = refresh.mock.calls.map((args) => args[1]);
    finish(createPassingValidationResult('prepare'));
    const result = await operation;
    expect(settledBeforeRelease).toBe(false);
    expect(before).toEqual([{ advisoryQaInFlight: true }]);
    expect(refresh).toHaveBeenLastCalledWith('prepare', { advisoryQaInFlight: false });
    expect(result.scope).toBe('pod');
    expect(f.advisoryRuns.get('prepare')).toBe(pending);
  });
  it('retains series scope and pod review when the original series selector accepts the pod', async () => {
    const f = fixture();
    f.validated();
    f.isSinglePrSeriesPod.mockReturnValueOnce(true);
    vi.spyOn(f.refresh.readinessService, 'computeSeriesReadiness').mockReturnValueOnce({
      status: 'risky',
      summary: 'Synthetic series risk',
      computedAt: new Date().toISOString(),
      scope: 'series',
      seriesId: 'series',
      memberCount: 1,
      memberStatuses: [],
      findings: [],
    });
    const result = await f.context.resolveApprovalReadiness({
      ...f.pod(),
      seriesId: 'series',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    expect(result).toMatchObject({
      status: 'risky',
      scope: 'series',
      seriesId: 'series',
      podReview: expect.any(Object),
    });
  });
  it('retains original approval identity allowances and rejects uncollected guidance', () => {
    const f = fixture();
    f.validated();
    const anchor = f.pod();
    f.podRepo.update('prepare', { status: 'complete', containerId: null });
    expect(() => f.context.assertApprovalCurrent(anchor)).toThrow(
      expect.objectContaining({ code: 'STALE_APPROVAL' }),
    );
    expect(() =>
      f.context.assertApprovalCurrent(anchor, { allowComplete: true, allowRemovedContainer: true }),
    ).not.toThrow();
    f.deps.nudgeRepo.queue('prepare', 'Retained guidance');
    expect(() =>
      f.context.assertApprovalCurrent(anchor, { allowComplete: true, allowRemovedContainer: true }),
    ).toThrow(expect.objectContaining({ code: 'UNCOLLECTED_HUMAN_GUIDANCE' }));
  });
});

describe('readiness dependency capture', () => {
  it('retains the original event repository after the manager live view changes', () => {
    const f = fixture();
    f.validated();
    const original = f.deps.eventRepo;
    const replacement = createEventRepository(f.db);
    const oldReads = vi.spyOn(original, 'getForSession');
    const replacementReads = vi.spyOn(replacement, 'getForSession');
    f.deps.eventRepo = replacement;
    f.refresh.readinessService.computePodReadiness('prepare');
    expect(oldReads).toHaveBeenCalled();
    expect(replacementReads).not.toHaveBeenCalled();
  });
});

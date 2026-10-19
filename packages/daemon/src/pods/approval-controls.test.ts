import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingFact } from '../test-utils/approval-helpers.js';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
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

describe('approval controls', () => {
  it('forwards bulk approval to the invocation receiver with exact automation options', async () => {
    const f = fixture();
    f.validated();
    const podReview = f.refresh.readinessService.computePodReadiness('prepare');
    vi.spyOn(f.controlsCaptured, 'resolveApprovalReadiness').mockResolvedValueOnce({
      status: 'ready',
      summary: 'Synthetic ready',
      scope: 'pod',
      podReview,
    });
    expect(await f.controls().approveAllValidated.call(f.calls)).toEqual({
      approved: ['prepare'],
      skipped: [],
    });
    expect(f.calls.approveSession).toHaveBeenCalledExactlyOnceWith('prepare', { automation: true });
  });
  it('records a non-ready bulk skip without calling the approval command', async () => {
    const f = fixture();
    f.validated();
    const podReview = f.refresh.readinessService.computePodReadiness('prepare');
    vi.spyOn(f.controlsCaptured, 'resolveApprovalReadiness').mockResolvedValueOnce({
      status: 'needs_review',
      summary: 'Synthetic missing evidence',
      scope: 'pod',
      podReview,
    });
    expect(await f.controls().approveAllValidated.call(f.calls)).toMatchObject({
      approved: [],
      skipped: [{ podId: 'prepare', status: 'needs_review' }],
    });
    expect(f.calls.approveSession).not.toHaveBeenCalled();
  });
  it('persists historical fact waiver and unrelated summary data through private SQLite reopen', async () => {
    const f = fixture(true);
    f.validated();
    const result = {
      ...createFailingValidationResult('prepare', 2),
      factValidation: { status: 'pending_human' as const, results: [pendingFact] },
    };
    f.deps.validationRepo?.insert('prepare', 2, result);
    f.podRepo.update('prepare', {
      status: 'failed',
      lastValidationResult: null,
      taskSummary: {
        actualSummary: 'Original summary',
        deviations: [
          { step: 'step', planned: 'planned', actual: 'retain', reason: 'retained evidence' },
        ],
      },
    });
    await f.controls().approveFactWaiver.call(f.calls, 'prepare', 'fact-one', 'Approved evidence', {
      type: 'human',
      userId: 'operator',
    });
    expect(f.calls.revalidateSession).toHaveBeenCalledExactlyOnceWith('prepare', { force: true });
    const pod = f.pod();
    expect(pod.taskSummary).toMatchObject({
      actualSummary: 'Original summary',
      deviations: [
        { step: 'step', planned: 'planned', actual: 'retain', reason: 'retained evidence' },
      ],
      factDeviations: [
        { factId: 'fact-one', decision: 'approved_waive', reason: 'Approved evidence' },
      ],
    });
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
  it('records active-run waivers without starting revalidation', async () => {
    const f = fixture();
    f.validated();
    f.podRepo.update('prepare', {
      status: 'running',
      lastValidationResult: {
        ...createFailingValidationResult('prepare'),
        factValidation: { status: 'pending_human', results: [pendingFact] },
      },
    });
    expect(await f.controls().approveFactWaiver.call(f.calls, 'prepare', 'fact-one')).toEqual({
      newCommits: false,
      result: 'fail',
    });
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('retains force approval waiver and escalation actor audit through actual SQLite reopen', async () => {
    const f = fixture(true);
    f.validated();
    const escalation = {
      id: 'question',
      podId: 'prepare',
      type: 'ask_human' as const,
      timestamp: new Date().toISOString(),
      payload: { question: 'Proceed?' },
      response: null,
    };
    f.deps.escalationRepo.insert(escalation);
    f.podRepo.update('prepare', {
      status: 'awaiting_input',
      pendingEscalation: escalation,
      lastValidationResult: createFailingValidationResult('prepare'),
    });
    await f
      .controls()
      .forceApprove('prepare', 'Approved override', { type: 'human', userId: 'operator' });
    const pod = f.pod();
    const audit = f.deps.escalationRepo.getOrThrow('question');
    expect(pod).toMatchObject({
      status: 'validated',
      pendingEscalation: null,
      validationWaiver: { actor: { type: 'human', userId: 'operator' } },
    });
    expect(audit.response?.actor).toEqual({ type: 'human', userId: 'operator' });
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(createEscalationRepository(f.db).getOrThrow('question')).toEqual(audit);
  });
});

describe('settled fact waiver safety', () => {
  it.each(['guidance', 'termination'] as const)(
    'records without revalidation when %s is unresolved',
    async (blocking) => {
      const f = fixture();
      f.validated();
      f.podRepo.update('prepare', {
        status: 'failed',
        lastValidationResult: {
          ...createFailingValidationResult('prepare'),
          factValidation: { status: 'pending_human', results: [pendingFact] },
        },
      });
      if (blocking === 'guidance') f.deps.nudgeRepo.queue('prepare', 'Saved correction');
      else {
        const tasks = f.podRepo.taskExecutions;
        const pod = f.pod();
        const cycle = f.podRepo.completionJournal?.get('prepare', pod.lifecycleGeneration)?.cycle;
        if (!tasks || cycle === undefined) throw new Error('Missing task/journal fixture');
        tasks.register('prepare');
        const run = tasks.beginRun('prepare', pod.lifecycleGeneration, cycle, {
          runtime: 'claude',
          model: pod.model,
          providerAccountId: 'account',
          resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
        });
        tasks.retainUnverifiedRun(run);
      }
      expect(await f.controls().approveFactWaiver.call(f.calls, 'prepare', 'fact-one')).toEqual({
        newCommits: false,
        result: 'fail',
      });
      expect(f.calls.revalidateSession).not.toHaveBeenCalled();
      expect(f.pod().taskSummary?.factDeviations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ factId: 'fact-one', decision: 'approved_waive' }),
        ]),
      );
      if (blocking === 'guidance') expect(f.deps.nudgeRepo.hasPending('prepare')).toBe(true);
      else expect(f.podRepo.taskExecutions?.hasUnverifiedTermination('prepare')).toBe(true);
    },
  );
});

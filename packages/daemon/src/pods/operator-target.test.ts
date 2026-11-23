import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { assertOperatorTarget, operatorTarget } from './operator-target.js';

const approvals: ReturnType<typeof createApprovalFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of approvals.splice(0)) f.close();
});

describe('guarded operator target admission', () => {
  it('ignores progress noise, but binds exact question content, lifecycle and validation evidence', () => {
    const f = createOperatorFixture();
    f.awaiting();
    const before = operatorTarget(f.pod()).expectedTarget;
    f.podRepo.update('prepare', { updatedAt: new Date().toISOString() });
    expect(operatorTarget(f.pod()).expectedTarget).toBe(before);
    const pending = f.pod().pendingEscalation!;
    f.podRepo.update('prepare', {
      pendingEscalation: {
        ...pending,
        payload: { question: 'A different question with the same ID' },
      },
    });
    expect(() => assertOperatorTarget(f.pod(), before)).toThrow('question/candidate changed');
  });
  it('rejects a stale answer before recording, nudging or resuming anything', async () => {
    const f = createOperatorFixture();
    const original = f.awaiting();
    const target = operatorTarget(f.pod()).expectedTarget;
    f.podRepo.update('prepare', { pendingEscalation: { ...original, id: 'new-question' } });
    await expect(
      f
        .messages()
        .sendMessage.call(
          f.calls,
          'prepare',
          'Answer intended for old question',
          { type: 'automation', id: 'works:parent' },
          { expectedTarget: target },
        ),
    ).rejects.toMatchObject({ code: 'STALE_OPERATOR_TARGET', statusCode: 409 });
    expect(f.pod().pendingEscalation?.id).toBe('new-question');
    expect(f.deps.escalationRepo.getOrThrow(original.id).response).toBeNull();
    expect(f.deps.nudgeRepo.listPending('prepare')).toHaveLength(0);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('records a fresh delegated routine answer as automation, never as a human', async () => {
    const f = createOperatorFixture();
    const question = f.awaiting(),
      waiter = f.waiter();
    await f
      .messages()
      .sendMessage.call(
        f.calls,
        'prepare',
        'Use version two',
        { type: 'automation', id: 'operator:user:works:parent' },
        { expectedTarget: operatorTarget(f.pod()).expectedTarget },
      );
    await expect(waiter.wait).resolves.toBe('Use version two');
    expect(f.deps.escalationRepo.getOrThrow(question.id).response).toMatchObject({
      respondedBy: 'ai',
      actor: { type: 'automation', id: 'operator:user:works:parent' },
    });
  });
  it('does not answer a backend-defined human-only decision', async () => {
    const f = createOperatorFixture();
    f.awaiting('ask_human', { kind: 'decision', question: 'Choose a destructive action?' });
    await expect(
      f
        .messages()
        .sendMessage.call(
          f.calls,
          'prepare',
          'Yes',
          { type: 'automation', id: 'works:parent' },
          { expectedTarget: operatorTarget(f.pod()).expectedTarget },
        ),
    ).rejects.toMatchObject({ code: 'HUMAN_DECISION_REQUIRED' });
    expect(f.pod().status).toBe('awaiting_input');
  });
  it('rejects a stale nudge without creating a queue entry', () => {
    const f = createOperatorFixture(),
      target = operatorTarget(f.pod()).expectedTarget;
    f.podRepo.update('prepare', { status: 'paused', pauseReason: 'manual' });
    expect(() => f.controls().nudgeSession('prepare', 'Guidance', target)).toThrow(
      'question/candidate changed',
    );
    expect(f.deps.nudgeRepo.listPending('prepare')).toHaveLength(0);
  });
  it('rechecks a validation target after asynchronous readiness, before publication or merge', async () => {
    const f = createApprovalFixture();
    approvals.push(f);
    f.validated();
    const target = operatorTarget(f.pod()).expectedTarget;
    const resolve = f.mainCaptured.resolveApprovalReadiness;
    f.mainCaptured.resolveApprovalReadiness = async (...args) => {
      const readiness = await resolve(...args);
      const result = f.pod().lastValidationResult!;
      f.podRepo.update('prepare', {
        lastValidationResult: { ...result, executionDispatchId: 'replacement-checks' },
      });
      return readiness;
    };
    await expect(
      f.workflow().approveSession('prepare', {
        expectedTarget: target,
        automation: true,
        actor: { type: 'automation', id: 'works:parent' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_OPERATOR_TARGET' });
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('validated');
  });
  it('retains normal approval checks for a fresh exact checked validation target', async () => {
    const f = createApprovalFixture();
    approvals.push(f);
    f.checked();
    await f.workflow().approveSession('prepare', {
      expectedTarget: operatorTarget(f.pod()).expectedTarget,
      automation: true,
      actor: { type: 'automation', id: 'works:parent' },
    });
    expect(f.pod().status).toBe('complete');
    expect(f.pod().readinessReview?.approval?.actor).toEqual({
      type: 'automation',
      id: 'works:parent',
    });
  });
});

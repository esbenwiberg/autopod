import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';

const fixtures: ReturnType<typeof createApprovalFixture>[] = [];
const actor = { type: 'human' as const, userId: 'operator' };
const reason = 'PR-only validation waiver; no merge or additional agent run authorized.';
function fixture() {
  const f = createApprovalFixture(true);
  fixtures.push(f);
  f.validated();
  const question = {
    id: 'question',
    podId: 'prepare',
    type: 'report_blocker' as const,
    timestamp: new Date().toISOString(),
    payload: {
      description: 'Baseline test worker OOM; choose how to proceed.',
      attempted: ['Compared unchanged baseline'],
      needs: 'A human validation decision',
    },
    response: null,
  };
  f.deps.escalationRepo.insert(question);
  f.podRepo.update('prepare', {
    status: 'awaiting_input',
    pendingEscalation: question,
    lastValidationResult: createFailingValidationResult('prepare'),
  });
  f.podRepo.completionJournal?.settle(f.pod(), 'Worker settled with a blocker');
  return f;
}
async function legacyFixture() {
  const f = fixture();
  await f.controls().forceApprove('prepare', reason, actor);
  // Recreate the old implementation: audit + waiver exist, receipt is absent.
  f.db.prepare('DELETE FROM completion_decisions WHERE pod_id = ?').run('prepare');
  f.db
    .prepare(`UPDATE pod_finalizations SET phase = 'awaiting_human',
    pending_decision_id = 'question' WHERE pod_id = ?`)
    .run('prepare');
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('validation override decision consistency', () => {
  it('repairs an exact legacy orphan only after a fresh explicit human override', async () => {
    const f = await legacyFixture();
    expect(() => f.context.assertApprovalCurrent(f.pod())).toThrow('unanswered human decision');
    f.mainCaptured.maybeTriggerDependents.mockClear();
    const confirmation = 'Reconcile the saved waiver without another agent run.';
    const reconciledReason = `${reason}\n\nDecision reconciliation: ${confirmation}`;
    await f.controls().forceApprove('prepare', confirmation, actor);
    expect(f.pod()).toMatchObject({
      status: 'validated',
      pendingEscalation: null,
      finalization: { phase: 'ready', pendingDecisionId: null },
      validationWaiver: { reason: reconciledReason, actor },
      containerId: 'container-123',
      prUrl: null,
    });
    expect(() => f.context.assertApprovalCurrent(f.pod())).not.toThrow();
    expect(f.deps.nudgeRepo.hasPending('prepare')).toBe(false);
    expect(f.calls.approveSession).not.toHaveBeenCalled();
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
    expect(f.mainCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
    // Normal validated pods still cannot be force-approved again.
    await expect(f.controls().forceApprove('prepare', reason, actor)).rejects.toThrow(
      'Cannot force-approve',
    );
    const next = f.reopen();
    expect(next.pods.hasUnansweredDecision?.('prepare')).toBe(false);
    expect(
      f.db.prepare('SELECT response, actor, question FROM completion_decisions').get(),
    ).toEqual({
      response: `[force-approve] ${reconciledReason}`,
      actor: JSON.stringify(actor),
      question: JSON.stringify({
        description: 'Baseline test worker OOM; choose how to proceed.',
        attempted: ['Compared unchanged baseline'],
        needs: 'A human validation decision',
      }),
    });
  });

  it('does not treat an unrelated validated pod as waiver reconciliation', async () => {
    const f = await legacyFixture();
    f.podRepo.update('prepare', { validationWaiver: null });
    const before = f.pod();
    await expect(f.controls().forceApprove('prepare', reason, actor)).rejects.toThrow(
      'Cannot force-approve',
    );
    expect(f.pod()).toEqual(before);
    expect(f.podRepo.hasUnansweredDecision?.('prepare')).toBe(true);
  });

  it.each([
    'automation',
    'missing-reason',
  ] as const)('does not discharge a decision for %s', async (kind) => {
    const f = fixture();
    const before = f.pod();
    await expect(
      f
        .controls()
        .forceApprove(
          'prepare',
          kind === 'missing-reason' ? undefined : reason,
          kind === 'automation' ? { type: 'automation', id: 'test' } : actor,
        ),
    ).rejects.toThrow('explicit human override');
    expect(f.pod()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM completion_decisions').all()).toEqual([]);
  });

  it.each([
    'missing',
    'other-pod',
    'not-force-approval',
    'automation',
    'different-pending',
  ] as const)('retains a legacy orphan when question evidence is %s', async (kind) => {
    const f = await legacyFixture();
    if (kind === 'missing') f.db.prepare('DELETE FROM escalations WHERE id = ?').run('question');
    if (kind === 'other-pod') {
      const saved = f.deps.escalationRepo.getOrThrow('question');
      vi.spyOn(f.deps.escalationRepo, 'getOrThrow').mockReturnValue({
        ...saved,
        podId: 'another-pod',
      });
    }
    if (kind === 'not-force-approval' || kind === 'automation') {
      f.deps.escalationRepo.update('question', {
        respondedAt: new Date().toISOString(),
        respondedBy: 'human',
        actor: kind === 'automation' ? { type: 'automation', id: 'test' } : actor,
        response:
          kind === 'not-force-approval' ? 'An unrelated answer' : `[force-approve] ${reason}`,
      });
    }
    if (kind === 'different-pending') {
      const pending = f.deps.escalationRepo.getOrThrow('question');
      f.podRepo.update('prepare', {
        pendingEscalation: {
          id: 'other-question',
          podId: 'prepare',
          type: pending.type,
          timestamp: pending.createdAt,
          payload: pending.payload,
          response: null,
        },
      });
    }
    const before = f.pod();
    await expect(f.controls().forceApprove('prepare', reason, actor)).rejects.toThrow();
    expect(f.pod()).toEqual(before);
    expect(f.podRepo.hasUnansweredDecision?.('prepare')).toBe(true);
    expect(f.db.prepare('SELECT * FROM completion_decisions').all()).toEqual([]);
  });

  it('rolls back receipt, audit, waiver, readiness and transition together on failure', async () => {
    const f = fixture();
    const before = f.pod();
    const audit = f.deps.escalationRepo.getOrThrow('question');
    const transition = f.controlsCaptured.transition;
    vi.spyOn(f.controlsCaptured, 'transition').mockImplementation((...args) => {
      transition(...args);
      throw new Error('synthetic transition failure');
    });
    const emit = vi.spyOn(f.deps.eventBus, 'emit');
    await expect(f.controls().forceApprove('prepare', reason, actor)).rejects.toThrow(
      'synthetic transition failure',
    );
    expect(f.pod()).toEqual(before);
    expect(f.deps.escalationRepo.getOrThrow('question')).toEqual(audit);
    expect(f.db.prepare('SELECT * FROM completion_decisions').all()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(before);
    expect(next.pods.hasUnansweredDecision?.('prepare')).toBe(true);
  });
});

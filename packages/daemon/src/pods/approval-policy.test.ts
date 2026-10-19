import type { OperatorActor, ValidationFinding } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { pendingFact } from '../test-utils/approval-helpers.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import {
  APPROVAL_SNAPSHOT_EXCLUDES,
  actorLabel,
  assertApprovalAllowed,
  buildValidationWaiver,
  legacyRespondedBy,
  normalizeApprovalReason,
  parseValidationOverrideResponse,
  taskSummaryWithApprovedFactWaiver,
} from './approval-policy.js';

describe('approval policy', () => {
  it.each([
    {
      actor: { type: 'human', userId: 'user', displayName: ' Human ' } as OperatorActor,
      label: 'Human',
      legacy: 'human',
    },
    {
      actor: { type: 'automation', id: 'schedule' } as OperatorActor,
      label: 'automation:schedule',
      legacy: 'ai',
    },
    {
      actor: { type: 'podsitter', decisionId: 'decision' } as OperatorActor,
      label: 'Podsitter decision decision',
      legacy: 'ai',
    },
  ])('preserves $label actor identity', ({ actor, label, legacy }) => {
    expect(actorLabel(actor)).toBe(label);
    expect(legacyRespondedBy(actor)).toBe(legacy);
  });
  it('retains reason/automation approval rules', () => {
    expect(normalizeApprovalReason(' reason ')).toBe('reason');
    expect(normalizeApprovalReason(' ')).toBeUndefined();
    expect(
      assertApprovalAllowed('pod', { status: 'ready', summary: '' }, { automation: true }),
    ).toBeUndefined();
    expect(() =>
      assertApprovalAllowed(
        'pod',
        { status: 'needs_review', summary: 'review' },
        { automation: true },
      ),
    ).toThrow(expect.objectContaining({ code: 'READINESS_NOT_READY' }));
    for (const status of ['risky', 'waived'] as const) {
      expect(() => assertApprovalAllowed('pod', { status, summary: '' }, { reason: ' ' })).toThrow(
        expect.objectContaining({ code: 'READINESS_REASON_REQUIRED' }),
      );
      expect(assertApprovalAllowed('pod', { status, summary: '' }, { reason: ' accepted ' })).toBe(
        'accepted',
      );
    }
  });
  it('preserves dismiss-all, one-based selection and guidance override decisions', () => {
    const findings: ValidationFinding[] = [
      { id: 'one', source: 'fact_validation', description: 'one' },
      { id: 'two', source: 'task_review', description: 'two' },
    ];
    expect(
      parseValidationOverrideResponse('dismiss all', findings).map((v) => v.findingId),
    ).toEqual(['one', 'two']);
    expect(
      parseValidationOverrideResponse('dismiss 2,2,9', findings).map((v) => v.findingId),
    ).toEqual(['two']);
    expect(parseValidationOverrideResponse(' use saved evidence ', findings)).toMatchObject([
      { action: 'guidance', guidance: 'use saved evidence' },
      { action: 'guidance', guidance: 'use saved evidence' },
    ]);
  });
  it('retains waiver actor, failed phases and unrelated task summary fields', () => {
    const actor: OperatorActor = { type: 'human', userId: 'operator' };
    const waiver = buildValidationWaiver(createFailingValidationResult('pod'), 'reason', actor);
    expect(waiver.actor).toBe(actor);
    expect(waiver.failedPhases.length).toBeGreaterThan(0);
    const summary = taskSummaryWithApprovedFactWaiver(
      {
        actualSummary: 'Retain',
        deviations: [
          { step: 'step', planned: 'planned', actual: 'original', reason: 'retained evidence' },
        ],
      },
      pendingFact,
      'reason',
      actor,
    );
    expect(summary).toMatchObject({
      actualSummary: 'Retain',
      deviations: [
        { step: 'step', planned: 'planned', actual: 'original', reason: 'retained evidence' },
      ],
      factDeviations: [{ factId: 'fact-one', decision: 'approved_waive', actor, reason: 'reason' }],
    });
    expect(APPROVAL_SNAPSHOT_EXCLUDES).toEqual(
      expect.arrayContaining(['.pnpm-store', '.turbo', '.venv', '__pycache__']),
    );
  });
});

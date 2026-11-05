import type {
  RetainedFinalizationReceipt,
  RetainedFinalizationRequest,
  RetainedFinalizationView,
} from '@autopod/shared';

export function finalizationRequest(): RetainedFinalizationRequest {
  return {
    requestKey: '12345678-1234-1234-1234-123456789abc',
    expectedGeneration: 2,
    expectedBinding: 'a'.repeat(64),
    mode: 'stop-retain',
    reason: '  Retain exact source and evidence without claiming delivery  ',
  };
}

export function finalizationReceipt(
  state: RetainedFinalizationReceipt['state'] = 'pending',
  request = finalizationRequest(),
): RetainedFinalizationReceipt {
  return {
    podId: 'retained-pod',
    request,
    actor: { type: 'human', userId: 'operator' },
    state,
    createdAt: '2026-06-01T00:00:00Z',
    finalizedAt: state === 'finalized' ? '2026-06-01T00:01:00Z' : null,
    message: state === 'pending' ? 'Stop outcome remains uncertain' : 'Finalization recorded',
    resourcesRetained: true,
  };
}

export function finalizationView(): RetainedFinalizationView {
  return {
    podId: 'retained-pod',
    generation: 2,
    status: 'failed',
    binding: 'a'.repeat(64),
    custody: [{ kind: 'continuation', id: 'held-owner' }],
    canStop: true,
    canCompleteMerged: false,
    blockers: ['External merge proof required'],
    operation: null,
  };
}

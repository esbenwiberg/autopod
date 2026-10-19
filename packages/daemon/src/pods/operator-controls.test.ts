import type { EscalationRequest } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
describe('operator nudge, escalation and bulk controls', () => {
  it('queues the exact nudge only for eligible state', () => {
    const f = createOperatorFixture();
    f.controls().nudgeSession('prepare', 'Exact instruction');
    expect(f.deps.nudgeRepo.listPending('prepare')[0]?.message).toBe('Exact instruction');
    f.podRepo.update('prepare', { status: 'complete' });
    expect(() => f.controls().nudgeSession('prepare', 'ignored')).toThrow();
    expect(f.deps.nudgeRepo.listPending('prepare')).toHaveLength(1);
  });
  it('attaches the supplied persisted escalation only while running', () => {
    const f = createOperatorFixture();
    const request: EscalationRequest = {
      id: 'notify-decision',
      podId: 'prepare',
      type: 'ask_human',
      timestamp: new Date().toISOString(),
      payload: { question: 'Proceed?' },
      response: null,
    };
    f.deps.escalationRepo.insert(request);
    f.controls().notifyEscalation('prepare', request);
    expect(f.pod()).toMatchObject({
      status: 'awaiting_input',
      pendingEscalation: request,
      escalationCount: 1,
    });
    f.controls().notifyEscalation('prepare', request);
    expect(f.pod().escalationCount).toBe(1);
  });
  it('continues a sequential failed-pod batch after an error and resolves the receiver dynamically', async () => {
    const f = createOperatorFixture();
    f.podRepo.update('prepare', { status: 'failed' });
    f.insertFix('failed');
    const ids = f.podRepo.list({ status: 'failed' }).map((pod) => pod.id);
    const replacement = vi.fn(async () => {});
    f.calls.killSession.mockImplementationOnce(async () => {
      f.calls.killSession = replacement;
      throw new Error('Synthetic kill failure');
    });
    await expect(f.controls().killAllFailed.call(f.calls)).resolves.toEqual({ killed: [ids[1]] });
    expect(replacement).toHaveBeenCalledWith(ids[1]);
    expect(replacement).toHaveBeenCalledOnce();
  });
});

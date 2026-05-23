import type { Pod, PodStatus } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePodsStore } from './pods.js';

function makePod(id: string, status: PodStatus, overrides: Partial<Pod> = {}): Pod {
  return {
    id,
    status,
    task: `task ${id}`,
    profileName: 'p',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  } as unknown as Pod;
}

describe('usePodsStore.applyEvent', () => {
  const initial = usePodsStore.getState();

  beforeEach(() => {
    usePodsStore.setState({ ...initial, pods: [], error: null, loading: false, connected: false });
  });

  afterEach(() => {
    usePodsStore.setState({ ...initial, pods: [], error: null, loading: false, connected: false });
  });

  it('pod.status_changed patches the matching pod', () => {
    usePodsStore.setState({ pods: [makePod('a', 'queued'), makePod('b', 'running')] });
    usePodsStore.getState().applyEvent({
      type: 'pod.status_changed',
      timestamp: 't',
      podId: 'b',
      previousStatus: 'running',
      newStatus: 'awaiting_input',
    });
    const pods = usePodsStore.getState().pods;
    expect(pods.find((p) => p.id === 'b')?.status).toBe('awaiting_input');
    expect(pods.find((p) => p.id === 'a')?.status).toBe('queued');
  });

  it('pod.status_changed is a no-op when no pod matches', () => {
    const before = [makePod('a', 'queued')];
    usePodsStore.setState({ pods: before });
    usePodsStore.getState().applyEvent({
      type: 'pod.status_changed',
      timestamp: 't',
      podId: 'nonexistent',
      previousStatus: 'queued',
      newStatus: 'running',
    });
    // Same reference — no spurious mutation
    expect(usePodsStore.getState().pods).toBe(before);
  });

  it('pod.completed patches status + completedAt', () => {
    usePodsStore.setState({ pods: [makePod('a', 'merging')] });
    usePodsStore.getState().applyEvent({
      type: 'pod.completed',
      timestamp: '2026-02-02T00:00:00Z',
      podId: 'a',
      finalStatus: 'complete',
      summary: {} as never,
    });
    const pod = usePodsStore.getState().pods.at(0);
    if (!pod) throw new Error('expected pod');
    expect(pod.status).toBe('complete');
    expect(pod.completedAt).toBe('2026-02-02T00:00:00Z');
  });

  it('pod.escalation_created flips status to awaiting_input and stores the escalation', () => {
    usePodsStore.setState({ pods: [makePod('a', 'running')] });
    usePodsStore.getState().applyEvent({
      type: 'pod.escalation_created',
      timestamp: 't',
      podId: 'a',
      escalation: { id: 'e1' } as never,
    });
    const pod = usePodsStore.getState().pods.at(0);
    if (!pod) throw new Error('expected pod');
    expect(pod.status).toBe('awaiting_input');
    expect(pod.pendingEscalation).toEqual({ id: 'e1' });
  });

  it('pod.escalation_resolved clears the pending escalation', () => {
    usePodsStore.setState({
      pods: [makePod('a', 'awaiting_input', { pendingEscalation: { id: 'e1' } as never })],
    });
    usePodsStore.getState().applyEvent({
      type: 'pod.escalation_resolved',
      timestamp: 't',
      podId: 'a',
      escalationId: 'e1',
      response: { kind: 'answer' } as never,
    });
    expect(usePodsStore.getState().pods[0]?.pendingEscalation).toBeNull();
  });

  it('pod.validation_completed patches lastValidationResult', () => {
    usePodsStore.setState({ pods: [makePod('a', 'validating')] });
    const result = { overall: 'pass' } as never;
    usePodsStore.getState().applyEvent({
      type: 'pod.validation_completed',
      timestamp: 't',
      podId: 'a',
      result,
    });
    expect(usePodsStore.getState().pods[0]?.lastValidationResult).toBe(result);
  });

  it('unknown events are ignored without mutating state', () => {
    const before = [makePod('a', 'running')];
    usePodsStore.setState({ pods: before });
    usePodsStore.getState().applyEvent({
      type: 'pod.firewall_denied',
      timestamp: 't',
      podId: 'a',
    } as never);
    expect(usePodsStore.getState().pods).toBe(before);
  });
});

describe('usePodsStore activity buffer', () => {
  const initial = usePodsStore.getState();
  beforeEach(() => {
    usePodsStore.setState({ ...initial, pods: [], activity: {} });
  });

  it('agent_activity is ignored when the pod is not being tracked', () => {
    usePodsStore.getState().applyEvent({
      type: 'pod.agent_activity',
      timestamp: 't',
      podId: 'untracked',
      event: { type: 'status', timestamp: 't', message: 'x' },
    });
    expect(usePodsStore.getState().activity).toEqual({});
  });

  it('agent_activity appends to the tracked pod and respects the cap', () => {
    usePodsStore.getState().trackActivity('a', []);
    for (let i = 0; i < 105; i += 1) {
      usePodsStore.getState().applyEvent({
        type: 'pod.agent_activity',
        timestamp: `t${i}`,
        podId: 'a',
        event: { type: 'status', timestamp: `t${i}`, message: `m${i}` },
      });
    }
    const buf = usePodsStore.getState().activity.a;
    expect(buf?.length).toBe(100);
    // Oldest dropped; newest retained
    const first = buf?.[0];
    const last = buf?.at(-1);
    expect(first && 'message' in first ? first.message : '').toBe('m5');
    expect(last && 'message' in last ? last.message : '').toBe('m104');
  });

  it('untrackActivity drops the buffer entirely', () => {
    usePodsStore.getState().trackActivity('a', [{ type: 'status', timestamp: 't', message: 'x' }]);
    usePodsStore.getState().untrackActivity('a');
    expect(usePodsStore.getState().activity.a).toBeUndefined();
  });
});

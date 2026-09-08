import type { Pod } from '@autopod/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePodsStore } from '../store/pods.js';
import { ActionBar } from './ActionBar.js';

it.each(['Branch preservation', 'Approval delivery', 'Source reconciliation'])(
  'waits for daemon evidence and retains a retryable action after %s fails',
  async (failure) => {
    // This view reads identity, status and readiness; unrelated full-pod fields are unused.
    const pod = { id: 'preserved', status: 'validated', readinessReview: null } as Pod;
    const initial = usePodsStore.getState();
    usePodsStore.setState({ pods: [pod] });
    let reply: (response: Response) => void = () => {
      throw new Error('Missing pending request');
    };
    const pending = new Promise<Response>((resolve) => {
      reply = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ActionBar pod={pod} />);
      });
      const approve = () =>
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Approve',
        );
      await act(async () => {
        approve()?.click();
      });
      expect(usePodsStore.getState().pods[0]?.status).toBe('validated');
      await act(async () => {
        reply(
          new Response(
            JSON.stringify({
              error:
                failure === 'Source reconciliation'
                  ? 'DELIVERY_RECONCILIATION_REQUIRED'
                  : failure === 'Branch preservation'
                    ? 'BRANCH_PRESERVATION_FAILED'
                    : 'APPROVAL_DELIVERY_FAILED',
              message: `${failure} failed. Original resources retained; repair remote access and retry approval.`,
            }),
            { status: failure === 'Source reconciliation' ? 409 : 502 },
          ),
        );
      });
      expect(container.textContent).toContain(
        'Original resources retained; repair remote access and retry approval.',
      );
      expect(usePodsStore.getState().pods[0]?.status).toBe('validated');
      expect(approve()?.disabled).toBe(false);
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
      await act(async () => {
        approve()?.click();
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain(`${failure} failed.`);
      expect(usePodsStore.getState().pods[0]?.status).toBe('validated');
      act(() => {
        usePodsStore.getState().applyEvent({
          type: 'pod.status_changed',
          timestamp: '2026-09-07T00:00:00Z',
          podId: pod.id,
          previousStatus: 'merging',
          newStatus: 'complete',
        });
      });
      expect(usePodsStore.getState().pods[0]?.status).toBe('complete');
    } finally {
      act(() => root.unmount());
      container.remove();
      fetch.mockRestore();
      usePodsStore.setState(initial);
    }
  },
);

it('refreshes accepted Rework from daemon evidence without a WebSocket event', async () => {
  const pod = { id: 'guidance', status: 'failed', options: { output: 'pr' } } as Pod;
  const initial = usePodsStore.getState();
  usePodsStore.setState({ pods: [pod] });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, accepted: true }), { status: 202 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...pod, status: 'queued' })));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ActionBar pod={pod} />);
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Rework')
        ?.click();
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/pods/guidance/validate',
      '/pods/guidance',
    ]);
    expect(usePodsStore.getState().pods[0]?.status).toBe('queued');
  } finally {
    act(() => root.unmount());
    container.remove();
    fetch.mockRestore();
    usePodsStore.setState(initial);
  }
});

it.each(['Resume', 'Rework'] as const)(
  'retains failed state and readable termination guidance after %s is rejected',
  async (action) => {
    const pod = { id: 'unverified', status: 'failed', options: { output: 'pr' } } as Pod;
    const initial = usePodsStore.getState();
    usePodsStore.setState({ pods: [pod] });
    const message =
      'A worker in this logical task has unverified process termination. Retain its source and resources; reconcile termination before Resume, Rework, validation or delivery.';
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            action === 'Resume'
              ? { error: message, code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED' }
              : { error: 'TASK_EXECUTION_TERMINATION_UNVERIFIED', message },
          ),
          { status: 409 },
        ),
      );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ActionBar pod={pod} />);
      });
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === action)
          ?.click();
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(message);
      expect(container.textContent).not.toContain('{"error"');
      expect(usePodsStore.getState().pods[0]).toEqual(pod);
    } finally {
      act(() => root.unmount());
      container.remove();
      fetch.mockRestore();
      usePodsStore.setState(initial);
    }
  },
);

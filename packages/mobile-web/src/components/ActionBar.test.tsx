import type { Pod } from '@autopod/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePodsStore } from '../store/pods.js';
import { ActionBar } from './ActionBar.js';

it('waits for daemon approval evidence and retains a retryable action after branch preservation fails', async () => {
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
            error: 'BRANCH_PRESERVATION_FAILED',
            message:
              'Branch preservation failed. Original resources retained; repair remote access and retry approval.',
          }),
          { status: 502 },
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
    expect(container.textContent).not.toContain('Branch preservation failed.');
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
});

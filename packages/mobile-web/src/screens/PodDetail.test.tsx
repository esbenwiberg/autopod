import type { Pod } from '@autopod/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { usePodsStore } from '../store/pods.js';
import { PodDetail } from './PodDetail.js';

it.each([
  { status: 'failed', unverified: false },
  { status: 'merge_pending', unverified: false },
  { status: 'failed', unverified: true },
] as const)(
  'shows retained delivery recovery and waits for explicit action (%s)',
  async ({ status, unverified }) => {
    const reason = unverified
      ? 'Codex execution termination is unverified; retain completion and source before another execution.'
      : status === 'failed'
        ? 'Delivery history is unavailable. Original resources retained. Use Resume to revalidate the retained source before approving delivery.'
        : 'Merge reconciliation required. Original resources retained.';
    const pod = {
      id: 'recovery',
      task: 'Recover delivery',
      profileName: 'fixture',
      runtime: 'codex',
      model: 'fixture',
      status,
      options: { agentMode: 'auto', output: 'pr', validate: true },
      failureReason: status === 'failed' ? reason : null,
      mergeBlockReason: reason,
      readinessReview: null,
      pendingEscalation: null,
      lastValidationResult: null,
      skipValidation: false,
    } as Pod;
    const initial = usePodsStore.getState();
    usePodsStore.setState({ pods: [pod] });
    const mutations: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (init?.method === 'POST') {
        mutations.push(path);
        return new Response(JSON.stringify({ ok: true, action: 'revalidate' }));
      }
      if (path.endsWith('/pods/recovery'))
        return new Response(
          JSON.stringify({
            ...pod,
            status: 'validated',
            failureReason: null,
            mergeBlockReason: null,
          }),
        );
      if (path.includes('/events') || path.endsWith('/validations')) return new Response('[]');
      return new Response(JSON.stringify({ message: 'Fixture metadata unavailable' }), {
        status: 503,
      });
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/pods/recovery']}>
            <Routes>
              <Route path="/pods/:id" element={<PodDetail />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      expect(container.textContent).toContain(reason);
      expect(mutations).toEqual([]);
      if (status === 'failed' && !unverified) {
        await act(async () => {
          [...container.querySelectorAll('button')]
            .find((button) => button.textContent === 'Resume')
            ?.click();
        });
        expect(mutations).toEqual(['/pods/recovery/resume']);
        expect(usePodsStore.getState().pods[0]?.status).toBe('validated');
        expect(container.textContent).not.toContain(reason);
        expect(
          [...container.querySelectorAll('button')].some(
            (button) => button.textContent === 'Approve',
          ),
        ).toBe(true);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
      fetch.mockRestore();
      usePodsStore.setState(initial);
    }
  },
);

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

it.each(['running', 'killing'] as const)(
  'shows the saved unresolved recovery hint without changing %s or launching work',
  async (status) => {
    const note =
      'Recovery paused: task execution or cleanup ownership remains unresolved. Source and resources are retained.';
    const pod = {
      id: 'retained',
      task: 'Preserve original task',
      profileName: 'fixture',
      runtime: 'copilot',
      model: 'fixture',
      status,
      lastRecoveryTrigger: 'restart',
      lastCorrectionMessage: note,
      options: { agentMode: 'auto', output: 'pr', validate: true },
      pendingEscalation: null,
      lastValidationResult: null,
    } as Pod;
    const initial = usePodsStore.getState();
    usePodsStore.setState({ pods: [pod] });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url).endsWith('/pods/retained')
          ? new Response(JSON.stringify(pod))
          : String(url).endsWith('/validations') || String(url).includes('/events')
            ? new Response('[]')
            : new Response('{}', { status: 503 }),
      );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={['/pods/retained']}>
            <Routes>
              <Route path="/pods/:id" element={<PodDetail />} />
            </Routes>
          </MemoryRouter>,
        ),
      );
      expect(container.textContent).toContain(note);
      expect(container.textContent).toContain('Preserve original task');
      expect(usePodsStore.getState().pods[0]?.status).toBe(status);
      expect(
        fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
      fetch.mockRestore();
      usePodsStore.setState(initial);
    }
  },
);

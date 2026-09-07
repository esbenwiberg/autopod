import type { Pod } from '@autopod/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DispatchPreflightPanel } from './DispatchPreflightPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
it('retains the complete rerun request through a lost response and reload', async () => {
  const draft = {
    profileName: 'frozen-profile',
    task: 'Original task',
    contract: { contractVersion: 1 },
    intentionalRerun: { ofPodId: 'source', reason: 'Reviewed repeat', requestKey: 'one-decision' },
  };
  localStorage.setItem('autopod.intentional-rerun.source', JSON.stringify(draft));
  const bodies: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new Error('Response lost after commit');
      return new Response(JSON.stringify({ id: 'same-execution' }));
    }
    expect(String(url)).toContain('dispatch-preflight');
    return new Response(
      JSON.stringify({
        latest: {
          status: 'review_required',
          baseCommitSha: 'a'.repeat(40),
          repository: 'example/repo',
          baseBranch: 'main',
          checkedAt: '2026-09-07',
          conflicts: [],
          rerun: null,
        },
      }),
    );
  });
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const pod = {
    id: 'source',
    updatedAt: 'now',
    profileName: 'mutated-profile',
    task: 'Edited after request',
    options: { agentMode: 'autonomous' },
  } as Pod;
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <DispatchPreflightPanel pod={pod} />
        </MemoryRouter>,
      );
    });
  const click = () =>
    act(async () => {
      (
        [...container.querySelectorAll('button')].find(
          (button) => button.textContent === 'Retry the same rerun request',
        ) as HTMLButtonElement
      ).click();
    });
  try {
    await render();
    expect(container.textContent).toContain('review_required');
    await click();
    expect(container.textContent).toContain('Response lost');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click();
    expect(bodies).toEqual([draft, draft]);
    expect(localStorage.getItem('autopod.intentional-rerun.source')).toBeNull();
    expect(container.textContent).toContain('Distinct execution created: same-execution');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

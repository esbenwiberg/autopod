import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskRetryPanel } from './TaskRetryPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
it('preserves one human authorization through lost response and reload without implicitly resuming', async () => {
  const input = { requestKey: 'durable-key', reason: 'External prerequisite checked' };
  localStorage.setItem('autopod.retry-authorization.fix', JSON.stringify(input));
  const state = {
    taskId: 'task',
    admissionCount: 4,
    executedCount: 3,
    transientRetryCount: 2,
    backoffsMs: [0, 0],
    measuredDurationMs: 15,
    interruptedCount: 1,
    latest: { id: 'failure', outcome: 'unknown' },
    authorizations: [] as Array<{
      id: string;
      failureId: string;
      reason: string;
      usedByAttemptId: string | null;
    }>,
  };
  const bodies: unknown[] = [];
  let resumes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('retry-authorizations')) {
      bodies.push(JSON.parse(String(init?.body)));
      state.authorizations = [
        { id: 'grant', failureId: 'failure', reason: input.reason, usedByAttemptId: null },
      ];
      if (bodies.length === 1) throw new Error('Response lost after commit');
      return new Response(JSON.stringify(state.authorizations[0]));
    }
    if (String(url).endsWith('/resume')) {
      resumes++;
      return new Response(JSON.stringify({ ok: true, action: 'revalidate' }));
    }
    return new Response(JSON.stringify(state));
  });
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const render = () =>
    act(async () => {
      root.render(<TaskRetryPanel podId="fix" revision="failed" status="failed" />);
    });
  const click = (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll('button')].find(
        (entry) => entry.textContent === label,
      );
      expect(button).toBeTruthy();
      button?.click();
    });
  try {
    await render();
    expect(container.textContent).toContain('3 executed / 4 admitted');
    expect(container.textContent).toContain('1 interrupted with unknown duration');
    await click('Retry recording the same authorization');
    expect(resumes).toBe(0);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('textarea')?.value).toBe(input.reason);
    await click('Retry recording the same authorization');
    expect(bodies).toEqual([input, input]);
    expect(resumes).toBe(0);
    expect(localStorage.getItem('autopod.retry-authorization.fix')).toBeNull();
    await click('Resume validation');
    expect(resumes).toBe(1);
    expect(container.textContent).toContain('Resume requested.');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('shows accounting without retry controls while a separate human decision is pending', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        admissionCount: 1,
        executedCount: 1,
        transientRetryCount: 0,
        backoffsMs: [0],
        measuredDurationMs: 3,
        interruptedCount: 0,
        latest: { id: 'failure', outcome: 'nonretryable' },
        authorizations: [],
      }),
    ),
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<TaskRetryPanel podId="pending" revision="pending" status="awaiting_input" />),
    );
    expect(container.textContent).toContain('Pending human decisions remain separate');
    expect(container.textContent).toContain('1 executed / 1 admitted');
    expect(container.querySelector('textarea')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Resume validation',
      ),
    ).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

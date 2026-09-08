import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskRetryPanel } from './TaskRetryPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
it.each(['validation', 'sandbox_startup', 'codex_interruption', 'worker'] as const)(
  'preserves one %s authorization through lost response and reload without implicitly resuming',
  async (stage) => {
    const input = { requestKey: 'durable-key', reason: 'External prerequisite checked' };
    const key = `autopod.retry-authorization.fix${stage === 'validation' ? '' : `.${stage}`}`;
    localStorage.setItem(key, JSON.stringify(input));
    const state = {
      taskId: 'task',
      authorizationRequired: stage === 'worker',
      admissionCount: 4,
      executedCount: 3,
      transientRetryCount: 2,
      backoffsMs: [0, 0],
      measuredDurationMs: 15,
      interruptedCount: 1,
      latest: {
        id: 'failure',
        outcome: stage === 'codex_interruption' ? 'pass' : 'unknown',
      },
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
      if (String(url).endsWith(stage === 'worker' ? '/validate' : '/resume')) {
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
        root.render(<TaskRetryPanel podId="fix" revision="failed" status="failed" stage={stage} />);
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
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          stage === 'validation' ? '/retry-state' : `/retry-state?stage=${stage}`,
        ),
        expect.anything(),
      );
      expect(container.textContent).toContain('3 executed / 4 admitted');
      expect(container.textContent).toContain('1 interrupted with unknown duration');
      await click('Retry recording the same authorization');
      expect(resumes).toBe(0);
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(container.querySelector('textarea')?.value).toBe(input.reason);
      await click('Retry recording the same authorization');
      const sent = { ...input, ...(stage === 'validation' ? {} : { stage }) };
      expect(bodies).toEqual([sent, sent]);
      if (stage === 'codex_interruption') {
        expect(container.textContent).toContain('Available for latest recovery');
        expect(container.textContent).toContain('Latest outcome: pass');
      }
      expect(resumes).toBe(0);
      expect(localStorage.getItem(key)).toBeNull();
      await click(
        stage === 'codex_interruption'
          ? 'Resume task'
          : stage === 'validation'
            ? 'Resume validation'
            : stage === 'worker'
              ? 'Rework worker'
              : 'Resume sandbox startup',
      );
      expect(resumes).toBe(1);
      expect(container.textContent).toContain(
        stage === 'worker' ? 'Rework requested.' : 'Resume requested.',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);

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

it('shows remaining worker cooldown allowance with Resume and no required permission form', async () => {
  const state = {
    taskId: 'task',
    stage: 'worker',
    admissionCount: 1,
    executedCount: 1,
    transientRetryCount: 0,
    backoffsMs: [1000, 5000],
    measuredDurationMs: 10,
    interruptedCount: 0,
    retryFailure: 'transient',
    authorizationRequired: false,
    latest: { id: 'throttled', outcome: 'transient' },
    authorizations: [],
  };
  let resumes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).endsWith('/validate')) {
      resumes++;
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify(state));
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TaskRetryPanel podId="throttled" stage="worker" status="failed" revision="failed" />,
      ),
    );
    expect(container.textContent).toContain('0 / 2 transient retry admissions');
    expect(container.querySelector('textarea')).toBeNull();
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Rework worker',
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    expect(resumes).toBe(1);
  } finally {
    act(() => root.unmount());
  }
});

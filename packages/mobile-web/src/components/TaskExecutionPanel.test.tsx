import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from '../lib/token.js';
import { TaskExecutionPanel } from './TaskExecutionPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('keeps unavailable accounting explicit and refreshes after a disconnected request', async () => {
  window.localStorage.setItem(STORAGE_KEY, 'token');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<TaskExecutionPanel podId="fix" revision="failed" />);
    });
    expect(container.textContent).toContain('Task accounting unavailable.');
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: 'logical-original',
          executionId: 'fix-execution',
          podCount: 2,
          agentRunCount: 3,
          providerAttemptCount: 4,
          validationExecutionCount: 5,
          recordedInputTokens: 90,
          recordedOutputTokens: 10,
          tokenBudget: 100,
          recordedCostUsd: 1.25,
          telemetry: 'partial',
          diagnostics: ['Infrastructure cost unavailable'],
        }),
        { status: 200 },
      ),
    );
    await act(async () => {
      container.querySelector('button')?.click();
    });
    expect(container.textContent).toContain('logical-original');
    expect(container.textContent).toContain(
      '2 pods · 3 recorded agent runs · 4 provider attempts · 5 validations',
    );
    expect(container.textContent).toContain('Recorded tokens: 100 / 100');
    expect(container.textContent).toContain('$1.2500 · partial telemetry');
    expect(container.textContent).toContain('Infrastructure cost unavailable');
    expect(fetch).toHaveBeenLastCalledWith('/pods/fix/task-execution', expect.anything());
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

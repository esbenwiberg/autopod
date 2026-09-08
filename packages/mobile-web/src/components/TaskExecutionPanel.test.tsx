import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from '../lib/token.js';
import { TaskExecutionPanel } from './TaskExecutionPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it.each([true, false])(
  'keeps unavailable accounting explicit and refreshes delivery observations (available: %s)',
  async (hasDisposition) => {
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
            budgetCheck: {
              status: 'unavailable',
              reason: 'Task token accounting incomplete; reconcile prior execution telemetry.',
            },
            recordedCostUsd: 1.25,
            costEvidence: {
              basis: 'stored_subtotal',
              billingVerified: false,
              knownEstimatedCostUsd: 0.5,
              unavailablePhaseCount: 1,
              conflictingPodCount: 1,
              omittedDiagnosticCount: 2,
              diagnostics: [
                {
                  podId: 'root',
                  code: 'PHASE_COST_CONFLICT',
                  message: 'Stored phase costs conflict; no proportional allocation applied.',
                },
              ],
            },
            telemetry: 'partial',
            ...(hasDisposition
              ? {
                  merge: {
                    prCount: 2,
                    requestCount: 3,
                    mergedPrCount: 1,
                    mergedWithoutRecordedRequestCount: 1,
                    unresolvedPrCount: 1,
                    scope: 'source-bound-journal-only',
                    basis: 'last-recorded',
                    liveVerified: false,
                  },
                }
              : {}),
            delivery: {
              intentCount: 2,
              receiptCount: 1,
              unresolvedCount: 1,
              scope: 'durable-receipts-only',
              ...(hasDisposition
                ? {
                    disposition: {
                      openCount: 0,
                      mergedCount: 1,
                      closedCount: 0,
                      unavailableCount: 0,
                      basis: 'last-recorded',
                      liveVerified: false,
                    },
                  }
                : {}),
            },
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
      expect(container.textContent).toContain(
        'Task token accounting incomplete; reconcile prior execution telemetry.',
      );
      expect(container.textContent).toContain('Stored task cost subtotal:');
      expect(container.textContent).toContain('Billing unverified');
      expect(container.textContent).toContain(
        'Known estimates: $0.5000 · 1 identified phases with unavailable cost · 1 pods with conflicting attribution',
      );
      expect(container.textContent).toContain(
        'Stored phase costs conflict; no proportional allocation applied.',
      );
      expect(container.textContent).toContain('2 additional cost diagnostics omitted.');
      expect(container.textContent).toContain('$1.2500 · partial telemetry');
      expect(container.textContent).toContain('Infrastructure cost unavailable');
      expect(container.textContent).toContain('1 PR receipts · 1 unresolved of 2 intents');
      expect(container.textContent).toContain(
        hasDisposition
          ? 'Last recorded PR status: 0 open · 1 merged · 0 closed · 0 unavailable'
          : 'PR disposition observations unavailable.',
      );
      expect(container.textContent).toContain(
        hasDisposition
          ? 'Source-bound merges: 1 merged PRs · 3 recorded requests · 1 unresolved of 2 PRs'
          : 'Source-bound merge evidence unavailable.',
      );
      if (hasDisposition)
        expect(container.textContent).toContain(
          '1 merged PRs observed with no recorded request; merge actor is not inferred.',
        );
      expect(container.textContent).toContain('Current provider status unverified.');
      expect(container.textContent).toContain('historical PR URLs are not reconstructed receipts');
      expect(fetch).toHaveBeenLastCalledWith('/pods/fix/task-execution', expect.anything());
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);

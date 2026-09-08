import type { ValidationResult } from '@autopod/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type StoredValidation,
  ValidationSummary,
  rowsFor,
  validationItemsForDisplay,
} from './ValidationSummary.js';

function result(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    podId: 'pod-1',
    attempt: 1,
    timestamp: '2026-01-01T10:00:00Z',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 20 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 1200,
    ...overrides,
  };
}

function stored(attempt: number, item: ValidationResult): StoredValidation {
  return {
    id: `val-${attempt}`,
    podId: 'pod-1',
    attempt,
    result: item,
    createdAt: item.timestamp,
  };
}

describe('validation display helpers', () => {
  it('uses the live latest result as fallback when history is empty', () => {
    const latest = result({ attempt: 2, overall: 'fail' });
    expect(validationItemsForDisplay([], latest).map((item) => item.result.attempt)).toEqual([2]);
  });

  it('retains durable failures when a latest snapshot disagrees with the same display attempt', () => {
    const attemptOne = result({ attempt: 1 });
    const attemptTwo = result({ attempt: 2, overall: 'fail' });
    const newerAttemptTwo = result({ attempt: 2, overall: 'pass' });

    const items = validationItemsForDisplay(
      [stored(1, attemptOne), stored(2, attemptTwo)],
      newerAttemptTwo,
    );

    expect(items.map((item) => item.result.attempt)).toEqual([2, 2, 1]);
    expect(items.map((item) => item.result.overall)).toEqual(['pass', 'fail', 'pass']);
  });

  it('uses durable history sequence when Resume resets display attempt numbers', () => {
    const first = {
      ...stored(3, result({ attempt: 3, overall: 'fail' })),
      id: 'old',
      sequence: 3,
      cycle: 0,
    };
    const resumed = { ...stored(1, result({ attempt: 1 })), id: 'resumed', sequence: 4, cycle: 1 };
    expect(
      validationItemsForDisplay([first, resumed], resumed.result).map((item) => item.id),
    ).toEqual(['resumed', 'old']);
  });
  it('does not show empty page coverage as a pass and identifies reused test evidence', () => {
    const rows = rowsFor(
      result({
        test: {
          status: 'pass',
          duration: 0,
          reusedEvidence: {
            receiptId: 'original-receipt',
            identityHash: 'a'.repeat(64),
            originalPodId: 'other-pod',
            originalExecutedAt: '2026-09-07T00:00:00Z',
            originalDurationMs: 1000,
          },
        },
      }),
    );
    expect(rows).toContainEqual(expect.objectContaining({ label: 'pages (0)', status: 'skip' }));
    expect(rows.find((row) => row.label === 'test')?.note).toContain('Reused');
  });

  it('labels infrastructure failure without claiming tests failed', () => {
    const rows = rowsFor(
      result({
        overall: 'fail',
        test: { status: 'skip', duration: 25, stdout: '', stderr: '' },
        infrastructureFailure: {
          phase: 'test',
          code: 'AZURE_SANDBOX_HTTP_ERROR',
          statusCode: 403,
          message: 'Azure Sandboxes returned an empty 403',
          retryable: true,
        },
      }),
    );

    expect(rows).toContainEqual({
      label: 'test infrastructure',
      status: 'fail',
      note: 'Azure Sandboxes returned an empty 403',
    });
    expect(rows).not.toContainEqual(expect.objectContaining({ note: 'Tests failed' }));
  });

  it('adds concise failure notes for failed phases', () => {
    const rows = rowsFor(
      result({
        overall: 'fail',
        smoke: {
          status: 'fail',
          build: { status: 'fail', output: 'Build exploded\nmore', duration: 100 },
          health: { status: 'fail', url: 'http://localhost:3000', responseCode: 500, duration: 20 },
          pages: [
            {
              path: '/',
              status: 'fail',
              screenshotPath: '',
              consoleErrors: [],
              assertions: [],
              loadTime: 10,
            },
          ],
        },
      }),
    );

    expect(rows).toContainEqual({ label: 'build', status: 'fail', note: 'Build exploded' });
    expect(rows).toContainEqual({ label: 'health', status: 'fail', note: 'HTTP 500' });
    expect(rows).toContainEqual({ label: 'pages (1)', status: 'fail', note: '1 failed' });
  });
});

describe('ValidationSummary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function clickByText(text: string): void {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === text,
    );
    if (!button) throw new Error(`button not found: ${text}`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('shows unavailable reviewer execution as failed and keeps prior finding history', async () => {
    const reason =
      'Review failed: Foundry tool review unavailable on the selected provider binding; reconcile it before retry.';
    const current = result({
      overall: 'fail',
      reviewSkipKind: 'review-failed',
      reviewSkipReason: reason,
      taskReview: {
        status: 'fail',
        reasoning: reason,
        issues: ['Retained prior finding'],
        model: 'selected',
        screenshots: [],
      },
    });
    await act(async () => {
      root.render(<ValidationSummary history={[stored(1, result()), stored(2, current)]} />);
    });
    expect(container.textContent).toContain(reason);
    expect(rowsFor(current).find((row) => row.label === 'review')).toMatchObject({
      status: 'fail',
      note: reason,
    });
    await act(async () => {
      clickByText('Show previous 1 attempt');
    });
    expect(container.textContent).toContain('Validation #1');
    expect(current.taskReview?.issues).toEqual(['Retained prior finding']);
    expect(
      rowsFor(
        result({
          overall: 'fail',
          reviewSkipKind: 'review-failed',
          reviewSkipReason: 'Reviewer termination could not be confirmed',
        }),
      ).find((row) => row.label === 'review')?.status,
    ).toBe('fail');
  });

  it('shows only the latest validation attempt by default', async () => {
    await act(async () => {
      root.render(
        <ValidationSummary
          history={[stored(1, result({ attempt: 1 })), stored(2, result({ attempt: 2 }))]}
        />,
      );
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Validation #2');
    expect(text).not.toContain('Validation #1');
    expect(text).toContain('Show previous 1 attempt');
  });

  it('can expand previous validation attempts latest first', async () => {
    await act(async () => {
      root.render(
        <ValidationSummary
          history={[stored(1, result({ attempt: 1 })), stored(2, result({ attempt: 2 }))]}
        />,
      );
    });

    await act(async () => {
      clickByText('Show previous 1 attempt');
    });

    const text = container.textContent ?? '';
    expect(text.indexOf('Validation #2')).toBeLessThan(text.indexOf('Validation #1'));
    expect(text).toContain('Hide previous attempts');
  });
});

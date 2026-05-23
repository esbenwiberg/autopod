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

  it('merges history and live latest by attempt in latest-first order', () => {
    const attemptOne = result({ attempt: 1 });
    const attemptTwo = result({ attempt: 2, overall: 'fail' });
    const newerAttemptTwo = result({ attempt: 2, overall: 'pass' });

    const items = validationItemsForDisplay(
      [stored(1, attemptOne), stored(2, attemptTwo)],
      newerAttemptTwo,
    );

    expect(items.map((item) => item.result.attempt)).toEqual([2, 1]);
    expect(items[0]?.result.overall).toBe('pass');
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

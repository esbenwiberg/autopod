import type { AgentEvent } from '@autopod/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityList, isOverviewActivity } from './ActivityList.js';

function status(message: string, timestamp = '2026-01-01T10:00:00Z'): AgentEvent {
  return { type: 'status', timestamp, message };
}

describe('ActivityList', () => {
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

  async function render(events: AgentEvent[], maxCount?: number): Promise<void> {
    await act(async () => {
      root.render(<ActivityList events={events} maxCount={maxCount} />);
    });
  }

  it('filters tool use and reasoning noise from overview activity', async () => {
    await render([
      status('started'),
      { type: 'tool_use', timestamp: '2026-01-01T10:00:01Z', tool: 'Read', input: {} },
      { type: 'reasoning', timestamp: '2026-01-01T10:00:02Z', text: 'thinking' },
      {
        type: 'progress',
        timestamp: '2026-01-01T10:00:03Z',
        phase: 'Build',
        description: 'Building cards',
        currentPhase: 2,
        totalPhases: 3,
      },
    ]);

    expect(container.textContent).toContain('started');
    expect(container.textContent).toContain('Building cards');
    expect(container.textContent).not.toContain('Read');
    expect(container.textContent).not.toContain('thinking');
  });

  it('shows the latest overview-worthy events only', async () => {
    await render(
      [
        status('one', '2026-01-01T10:00:01Z'),
        status('two', '2026-01-01T10:00:02Z'),
        status('three', '2026-01-01T10:00:03Z'),
      ],
      2,
    );

    expect(container.textContent).not.toContain('one');
    expect(container.textContent).toContain('two');
    expect(container.textContent).toContain('three');
  });
});

describe('isOverviewActivity', () => {
  it('matches the desktop overview-worthy event set', () => {
    expect(isOverviewActivity({ type: 'tool_use', timestamp: 't', tool: 'Read', input: {} })).toBe(
      false,
    );
    expect(isOverviewActivity({ type: 'reasoning', timestamp: 't', text: 'thinking' })).toBe(false);
    expect(isOverviewActivity({ type: 'complete', timestamp: 't', result: 'done' })).toBe(true);
  });
});

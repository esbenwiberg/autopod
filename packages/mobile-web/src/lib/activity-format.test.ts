import type { AgentEvent } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { formatActivity, shortTime } from './activity-format.js';

function ev<T extends AgentEvent>(e: T): T {
  return e;
}

describe('formatActivity', () => {
  it('renders status', () => {
    const out = formatActivity(ev({ type: 'status', timestamp: 't', message: 'starting up' }), 0);
    expect(out.text).toBe('starting up');
    expect(out.tone).toBe('neutral');
  });

  it('renders tool_use with the tool name', () => {
    const out = formatActivity(
      ev({ type: 'tool_use', timestamp: 't', tool: 'Read', input: {} }),
      0,
    );
    expect(out.text).toBe('Read');
    expect(out.tone).toBe('info');
  });

  it('renders file_change with action + path', () => {
    const out = formatActivity(
      ev({ type: 'file_change', timestamp: 't', action: 'modify', path: 'src/App.tsx' }),
      0,
    );
    expect(out.text).toBe('modify src/App.tsx');
  });

  it('renders progress with phase counts', () => {
    const out = formatActivity(
      ev({
        type: 'progress',
        timestamp: 't',
        phase: 'p',
        description: 'building',
        currentPhase: 2,
        totalPhases: 5,
      }),
      0,
    );
    expect(out.text).toContain('building');
    expect(out.text).toContain('(2/5)');
  });

  it('renders error with danger tone when fatal', () => {
    const out = formatActivity(
      ev({ type: 'error', timestamp: 't', message: 'boom', fatal: true }),
      0,
    );
    expect(out.tone).toBe('danger');
    expect(out.text).toBe('boom');
  });

  it('renders non-fatal error with warn tone', () => {
    const out = formatActivity(
      ev({ type: 'error', timestamp: 't', message: 'flaky', fatal: false }),
      0,
    );
    expect(out.tone).toBe('warn');
  });

  it('truncates long text and collapses whitespace', () => {
    const out = formatActivity(
      ev({ type: 'status', timestamp: 't', message: `hello\n\n${'x'.repeat(300)}` }),
      0,
    );
    expect(out.text.length).toBeLessThanOrEqual(161);
    expect(out.text.endsWith('…')).toBe(true);
  });
});

describe('shortTime', () => {
  it('extracts HH:MM:SS from an ISO timestamp', () => {
    expect(shortTime('2026-05-20T14:23:11Z')).toBe('14:23:11');
    expect(shortTime('2026-05-20T14:23:11.456Z')).toBe('14:23:11');
  });

  it('returns the original string when the format does not match', () => {
    expect(shortTime('not-a-date')).toBe('not-a-date');
  });
});

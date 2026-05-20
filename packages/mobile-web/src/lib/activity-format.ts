import type { AgentEvent } from '@autopod/shared';

export interface FormattedActivity {
  /** Stable key for React lists — falls back to (timestamp + type) when no id is present. */
  key: string;
  timestamp: string;
  /** Glyph rendered in a fixed-width slot. Plain ASCII, no emoji. */
  glyph: string;
  /** Tone for the glyph + text — drives CSS class on the list row. */
  tone: 'neutral' | 'info' | 'ok' | 'warn' | 'danger';
  /** One-line summary (already trimmed). */
  text: string;
}

const TRIM = 160;

function shorten(s: string, n = TRIM): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function formatActivity(event: AgentEvent, index: number): FormattedActivity {
  const key = `${event.timestamp}-${event.type}-${index}`;
  switch (event.type) {
    case 'status':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '•',
        tone: 'neutral',
        text: shorten(event.message),
      };
    case 'reasoning':
      return { key, timestamp: event.timestamp, glyph: '…', tone: 'neutral', text: 'thinking' };
    case 'tool_use':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '⚒',
        tone: 'info',
        text: event.tool,
      };
    case 'file_change':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '✎',
        tone: 'info',
        text: `${event.action} ${event.path}`,
      };
    case 'plan':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '☰',
        tone: 'info',
        text: shorten(event.summary),
      };
    case 'progress':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '▸',
        tone: 'info',
        text: `${shorten(event.description, 100)} (${event.currentPhase}/${event.totalPhases})`,
      };
    case 'task_summary':
      return {
        key,
        timestamp: event.timestamp,
        glyph: 'Σ',
        tone: 'ok',
        text: shorten(event.actualSummary),
      };
    case 'escalation':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '?',
        tone: 'warn',
        text: `escalation: ${event.escalationType}`,
      };
    case 'complete':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '✓',
        tone: 'ok',
        text: shorten(event.result || 'complete'),
      };
    case 'error':
      return {
        key,
        timestamp: event.timestamp,
        glyph: '✗',
        tone: event.fatal ? 'danger' : 'warn',
        text: shorten(event.message),
      };
  }
}

const HHMMSS = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/;

/** "2026-05-20T14:23:11Z" → "14:23:11". Falls back to the input on mismatch. */
export function shortTime(iso: string): string {
  const m = HHMMSS.exec(iso);
  return m?.[1] ?? iso;
}

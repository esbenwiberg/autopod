import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  formatPrFallbackActivity,
  reportPrDescriptionFallback,
} from './pr-description-fallback.js';

const API_DETAIL =
  'provider=max route=oauth model=claude-haiku-4-5 status=401 type=authentication_error: invalid x-api-key [redacted]';

describe('formatPrFallbackActivity', () => {
  it('returns null when nothing fell back', () => {
    expect(formatPrFallbackActivity({ url: 'u', usedFallback: false })).toBeNull();
  });

  it('names what fell back, the reason and the diagnostic detail', () => {
    expect(
      formatPrFallbackActivity({
        url: 'u',
        usedFallback: true,
        fallbackReason: 'api_call_failed',
        fallbackDetail: API_DETAIL,
        titleUsedFallback: true,
        narrativeUsedFallback: true,
      }),
    ).toBe(`PR title + body used template fallback: api_call_failed (${API_DETAIL})`);
  });

  it('bounds long details and collapses whitespace', () => {
    const message = formatPrFallbackActivity({
      url: 'u',
      usedFallback: true,
      fallbackReason: 'json_parse_failed',
      fallbackDetail: `line one\n\n${'x'.repeat(500)}`,
      narrativeUsedFallback: true,
    });
    expect(message).toMatch(/^PR body used template fallback: json_parse_failed \(line one x+…\)$/);
    expect(message?.length).toBeLessThanOrEqual(320);
  });

  it('labels a title-only fallback and omits an empty detail', () => {
    expect(
      formatPrFallbackActivity({
        url: 'u',
        usedFallback: true,
        fallbackReason: 'no_credentials',
        titleUsedFallback: true,
        narrativeUsedFallback: false,
      }),
    ).toBe('PR title used template fallback: no_credentials');
  });
});

describe('reportPrDescriptionFallback', () => {
  it('logs and emits the diagnosable fallback once', () => {
    const emit = vi.fn();
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });

    reportPrDescriptionFallback({
      result: {
        url: 'u',
        usedFallback: true,
        fallbackReason: 'api_call_failed',
        fallbackDetail: API_DETAIL,
        titleUsedFallback: true,
        narrativeUsedFallback: true,
      },
      podId: 'pod12345',
      context: 'validation',
      profile: { name: 'p', modelProvider: 'max' },
      logger,
      emitActivityStatus: emit,
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      'pod12345',
      `PR title + body used template fallback: api_call_failed (${API_DETAIL})`,
    );
    const logged = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(logged).toMatchObject({
      podId: 'pod12345',
      context: 'validation',
      modelProvider: 'max',
      fallbackReason: 'api_call_failed',
      fallbackDetail: API_DETAIL,
      titleUsedFallback: true,
      narrativeUsedFallback: true,
    });
  });

  it('does nothing when no fallback was used', () => {
    const emit = vi.fn();
    reportPrDescriptionFallback({
      result: { url: 'u', usedFallback: false },
      podId: 'pod12345',
      context: 'validation',
      profile: { name: 'p', modelProvider: 'max' },
      logger: pino({ level: 'silent' }),
      emitActivityStatus: emit,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

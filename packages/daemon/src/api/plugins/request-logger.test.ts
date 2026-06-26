import { describe, expect, it } from 'vitest';
import { sanitizeRequestUrl } from './request-logger.js';

describe('sanitizeRequestUrl', () => {
  it('redacts sensitive query parameters before logging', () => {
    expect(sanitizeRequestUrl('/events?token=eyJ.secret&lastEventId=42')).toBe(
      '/events?token=[REDACTED]&lastEventId=42',
    );
    expect(sanitizeRequestUrl('/callback?access_token=abc&apiKey=def&state=ok')).toBe(
      '/callback?access_token=[REDACTED]&apiKey=[REDACTED]&state=ok',
    );
  });

  it('preserves non-sensitive query parameters', () => {
    expect(sanitizeRequestUrl('/pods/sess-001/events?limit=500')).toBe(
      '/pods/sess-001/events?limit=500',
    );
  });
});

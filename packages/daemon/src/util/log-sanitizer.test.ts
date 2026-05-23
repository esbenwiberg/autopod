import { describe, expect, it } from 'vitest';
import { capLargeStrings } from './log-sanitizer.js';

describe('capLargeStrings', () => {
  it('preserves Error instances so pino can serialize them', () => {
    const err = new Error('Git workspace setup failed');
    const result = capLargeStrings({ err, nested: { err } }) as {
      err: Error;
      nested: { err: Error };
    };

    expect(result.err).toBe(err);
    expect(result.nested.err).toBe(err);
  });

  it('truncates large non-error string fields', () => {
    const result = capLargeStrings({ value: 'x'.repeat(20_000) }) as { value: string };

    expect(result.value).toBe('<truncated: 20000 bytes, max 16384>');
  });
});

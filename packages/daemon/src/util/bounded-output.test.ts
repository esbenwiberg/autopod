import { describe, expect, it } from 'vitest';
import {
  BoundedOutputCollector,
  boundOutput,
  VALIDATION_OUTPUT_HEAD,
  VALIDATION_OUTPUT_LIMIT,
} from './bounded-output.js';

/** A large vitest-like log: the context is first, the failure and summary last. */
function largeSuiteLog(): string {
  return [
    '> autopod@ test /workspace',
    '> turbo run test --concurrency=1',
    ...Array.from({ length: 4_000 }, (_, i) => ` ✓ src/module-${i}.test.ts (12 tests) 34ms`),
    ' FAIL  src/pods/broken.test.ts > retries the failed step',
    'AssertionError: expected 2 to be 3',
    ' Test Files  1 failed | 4000 passed (4001)',
    '@autopod/daemon#test: command exited (1)',
  ].join('\n');
}

describe('boundOutput', () => {
  it('returns output within the limit unchanged', () => {
    expect(boundOutput('short')).toBe('short');
    const exact = 'x'.repeat(VALIDATION_OUTPUT_LIMIT);
    expect(boundOutput(exact)).toBe(exact);
  });

  it('keeps the beginning, an explicit marker and the final failure summary', () => {
    const log = largeSuiteLog();
    expect(log.length).toBeGreaterThan(150_000);
    const bounded = boundOutput(log);
    expect(bounded.length).toBeLessThanOrEqual(VALIDATION_OUTPUT_LIMIT);
    expect(bounded.length).toBeGreaterThan(VALIDATION_OUTPUT_LIMIT - 100);
    expect(bounded.startsWith('> autopod@ test /workspace')).toBe(true);
    expect(bounded).toMatch(
      /\[\.\.\. \d+ characters omitted; beginning and end of output retained/,
    );
    expect(bounded).toContain('FAIL  src/pods/broken.test.ts > retries the failed step');
    expect(bounded).toContain('AssertionError: expected 2 to be 3');
    expect(bounded.endsWith('@autopod/daemon#test: command exited (1)')).toBe(true);
    const [head = '', tail = ''] = bounded.split(/\n\n\[\.\.\. .*? \.\.\.\]\n\n/);
    expect(head).toBe(log.slice(0, VALIDATION_OUTPUT_HEAD));
    expect(log.endsWith(tail)).toBe(true);
    const omitted = Number(/\[\.\.\. (\d+) characters omitted/.exec(bounded)?.[1]);
    expect(head.length + omitted + tail.length).toBe(log.length);
  });

  it('never splits a surrogate pair at either cut', () => {
    for (const offset of [0, 1]) {
      const text = `${'a'.repeat(offset)}${'🦊'.repeat(60_000)}`;
      const bounded = boundOutput(text, 1_000, 200);
      expect(bounded.length).toBeLessThanOrEqual(1_000);
      expect(Buffer.from(bounded, 'utf8').toString('utf8')).toBe(bounded);
      expect(bounded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(bounded).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('honors limits smaller than the marker', () => {
    expect(boundOutput('x'.repeat(500), 20, 10)).toBe('x'.repeat(20));
    expect(boundOutput('x'.repeat(500), 0, 10)).toBe('');
  });
});

describe('BoundedOutputCollector', () => {
  it.each([1, 7, 997, 65_536])('matches boundOutput on the full stream (chunk %s)', (size) => {
    const log = `${largeSuiteLog()}\n${'🦊'.repeat(5_000)}\nfinal line`;
    const collector = new BoundedOutputCollector();
    for (let i = 0; i < log.length; i += size) collector.push(log.slice(i, i + size));
    expect(collector.toString()).toBe(boundOutput(log));
  });

  it('returns small streams verbatim', () => {
    const collector = new BoundedOutputCollector();
    collector.push('first ');
    collector.push('');
    collector.push('second');
    expect(collector.toString()).toBe('first second');
  });
});

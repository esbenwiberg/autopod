import { describe, it, expect } from 'vitest';
import { parsePageResults } from './parse-results.js';

const PASS_RESULT = {
  path: '/',
  status: 'pass',
  screenshotPath: '/tmp/root.png',
  consoleErrors: [],
  assertions: [],
  loadTime: 250,
};

function wrap(json: string): string {
  return `__AUTOPOD_PAGE_RESULTS_START__\n${json}\n__AUTOPOD_PAGE_RESULTS_END__`;
}

describe('parsePageResults', () => {
  it('extracts JSON between markers from clean output', () => {
    const stdout = wrap(JSON.stringify([PASS_RESULT]));
    const results = parsePageResults(stdout);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/');
    expect(results[0].status).toBe('pass');
    expect(results[0].loadTime).toBe(250);
  });

  it('extracts JSON from noisy output', () => {
    const noise = 'Debugger listening on ws://127.0.0.1:9229\nSome warning\n';
    const stdout = noise + wrap(JSON.stringify([PASS_RESULT])) + '\nCleanup done.\n';
    const results = parsePageResults(stdout);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/');
  });

  it('falls back to array detection when markers absent', () => {
    const stdout = 'some junk\n' + JSON.stringify([PASS_RESULT]) + '\nmore junk';
    const results = parsePageResults(stdout);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });

  it('returns empty array for garbage input', () => {
    const results = parsePageResults('total garbage with no json at all');
    expect(results).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    const results = parsePageResults('');
    expect(results).toEqual([]);
  });

  it('normalizes bad status to fail', () => {
    const bad = { ...PASS_RESULT, status: 'exploded' };
    const stdout = wrap(JSON.stringify([bad]));
    const results = parsePageResults(stdout);
    expect(results[0].status).toBe('fail');
  });

  it('handles malformed JSON gracefully', () => {
    const stdout = wrap('{not valid json[[[');
    const results = parsePageResults(stdout);
    expect(results).toEqual([]);
  });

  it('parses multiple page results correctly', () => {
    const pages = [
      { ...PASS_RESULT, path: '/home', loadTime: 100 },
      { ...PASS_RESULT, path: '/about', status: 'fail', consoleErrors: ['TypeError: x is undefined'], loadTime: 400 },
      {
        ...PASS_RESULT,
        path: '/contact',
        assertions: [
          { selector: 'h1', type: 'exists', expected: undefined, actual: '1', passed: true },
          { selector: '.form', type: 'visible', expected: undefined, actual: 'hidden', passed: false },
        ],
      },
    ];
    const stdout = wrap(JSON.stringify(pages));
    const results = parsePageResults(stdout);
    expect(results).toHaveLength(3);
    expect(results[0].path).toBe('/home');
    expect(results[0].loadTime).toBe(100);
    expect(results[1].path).toBe('/about');
    expect(results[1].status).toBe('fail');
    expect(results[1].consoleErrors).toEqual(['TypeError: x is undefined']);
    expect(results[2].assertions).toHaveLength(2);
    expect(results[2].assertions[0].passed).toBe(true);
    expect(results[2].assertions[1].passed).toBe(false);
  });
});

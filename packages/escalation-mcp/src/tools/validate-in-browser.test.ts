import { describe, expect, it, vi } from 'vitest';
import {
  isLocalhostUrl,
  parseResults,
  stripMarkdownFences,
  validateInBrowser,
} from './validate-in-browser.js';

// ─── URL validation ──────────────────────────────────────────────

describe('isLocalhostUrl', () => {
  it('accepts http://localhost', () => {
    expect(isLocalhostUrl('http://localhost')).toBe(true);
  });

  it('accepts http://localhost:3000/', () => {
    expect(isLocalhostUrl('http://localhost:3000/')).toBe(true);
  });

  it('accepts http://localhost:3000/settings', () => {
    expect(isLocalhostUrl('http://localhost:3000/settings')).toBe(true);
  });

  it('accepts http://127.0.0.1:8080/api', () => {
    expect(isLocalhostUrl('http://127.0.0.1:8080/api')).toBe(true);
  });

  it('accepts https://localhost:443/path', () => {
    expect(isLocalhostUrl('https://localhost:443/path')).toBe(true);
  });

  it('rejects external URLs', () => {
    expect(isLocalhostUrl('http://example.com')).toBe(false);
    expect(isLocalhostUrl('https://google.com')).toBe(false);
    expect(isLocalhostUrl('http://localhost.evil.com')).toBe(false);
  });

  it('rejects non-HTTP schemes', () => {
    expect(isLocalhostUrl('ftp://localhost')).toBe(false);
    expect(isLocalhostUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLocalhostUrl('')).toBe(false);
  });

  it('rejects bare localhost without scheme', () => {
    expect(isLocalhostUrl('localhost:3000')).toBe(false);
  });
});

// ─── Result parsing ──────────────────────────────────────────────

describe('parseResults', () => {
  const checks = ['Page has a title', 'Button is clickable'];

  it('parses valid results from stdout markers', () => {
    const stdout = `some noise
__AUTOPOD_BROWSER_RESULTS_START__
[
  { "check": "Page has a title", "passed": true, "reasoning": "Found h1 with text" },
  { "check": "Button is clickable", "passed": false, "reasoning": "Button was disabled" }
]
__AUTOPOD_BROWSER_RESULTS_END__
more noise`;

    const results = parseResults(stdout, checks);

    expect(results).toHaveLength(2);
    expect(results[0].check).toBe('Page has a title');
    expect(results[0].passed).toBe(true);
    expect(results[0].reasoning).toBe('Found h1 with text');
    expect(results[1].passed).toBe(false);
    expect(results[1].reasoning).toBe('Button was disabled');
  });

  it('returns failures when markers are missing', () => {
    const results = parseResults('no markers here', checks);

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(false);
    expect(results[0].reasoning).toContain('parseable');
    expect(results[1].passed).toBe(false);
  });

  it('returns failures when JSON is invalid', () => {
    const stdout = `__AUTOPOD_BROWSER_RESULTS_START__
not json
__AUTOPOD_BROWSER_RESULTS_END__`;

    const results = parseResults(stdout, checks);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.passed)).toBe(true);
    expect(results[0].reasoning).toContain('parse');
  });

  it('returns failures when result is not an array', () => {
    const stdout = `__AUTOPOD_BROWSER_RESULTS_START__
{"not": "an array"}
__AUTOPOD_BROWSER_RESULTS_END__`;

    const results = parseResults(stdout, checks);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.passed)).toBe(true);
  });

  it('handles fewer results than checks', () => {
    const stdout = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "Page has a title", "passed": true, "reasoning": "found it" }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const results = parseResults(stdout, checks);

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].reasoning).toBe('No result returned for this check');
  });

  it('preserves original check text over script output', () => {
    const stdout = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "different text", "passed": true, "reasoning": "ok" }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const results = parseResults(stdout, ['Original check text']);

    expect(results[0].check).toBe('Original check text');
  });

  it('defaults reasoning when missing', () => {
    const stdout = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "x", "passed": true }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const results = parseResults(stdout, ['x']);

    expect(results[0].reasoning).toBe('No reasoning provided');
  });
});

// ─── Markdown fence stripping ────────────────────────────────────

describe('stripMarkdownFences', () => {
  it('strips triple backtick fences', () => {
    expect(stripMarkdownFences('```\ncode here\n```')).toBe('code here');
  });

  it('strips fences with language tag', () => {
    expect(stripMarkdownFences('```javascript\ncode\n```')).toBe('code');
  });

  it('returns plain text unchanged', () => {
    expect(stripMarkdownFences('just code')).toBe('just code');
  });
});

// ─── Full tool flow (with mocked bridge) ─────────────────────────

describe('validateInBrowser', () => {
  function makeBridge(scriptOutput: string) {
    return {
      callReviewerModel: vi.fn().mockResolvedValue('console.log("script")'),
      writeFileInContainer: vi.fn().mockResolvedValue(undefined),
      execInContainer: vi.fn().mockImplementation((_sid: string, cmd: string[]) => {
        if (cmd[0] === 'mkdir') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'node') {
          return Promise.resolve({ stdout: scriptOutput, stderr: '', exitCode: 0 });
        }
        // base64 screenshot collection
        if (cmd[0] === 'sh') {
          return Promise.resolve({ stdout: 'base64data', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }),
    };
  }

  it('rejects non-localhost URLs', async () => {
    const bridge = makeBridge('');

    await expect(
      validateInBrowser('sess-1', { url: 'http://evil.com', checks: ['test'] }, bridge as never),
    ).rejects.toThrow('localhost');
  });

  it('rejects empty checks array', async () => {
    const bridge = makeBridge('');

    await expect(
      validateInBrowser('sess-1', { url: 'http://localhost:3000', checks: [] }, bridge as never),
    ).rejects.toThrow('At least one check');
  });

  it('returns structured results for a passing check', async () => {
    const scriptOutput = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "Has title", "passed": true, "reasoning": "Found it" }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const bridge = makeBridge(scriptOutput);
    const result = await validateInBrowser(
      'sess-1',
      { url: 'http://localhost:3000', checks: ['Has title'] },
      bridge as never,
    );

    const parsed = JSON.parse(result);
    expect(parsed.passed).toBe(true);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].passed).toBe(true);
    expect(parsed.results[0].screenshot).toBe('base64data');
  });

  it('returns passed=false when any check fails', async () => {
    const scriptOutput = `__AUTOPOD_BROWSER_RESULTS_START__
[
  { "check": "Has title", "passed": true, "reasoning": "ok" },
  { "check": "Has button", "passed": false, "reasoning": "not found" }
]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const bridge = makeBridge(scriptOutput);
    const result = await validateInBrowser(
      'sess-1',
      { url: 'http://localhost:3000', checks: ['Has title', 'Has button'] },
      bridge as never,
    );

    const parsed = JSON.parse(result);
    expect(parsed.passed).toBe(false);
    expect(parsed.results[0].passed).toBe(true);
    expect(parsed.results[1].passed).toBe(false);
  });

  it('calls bridge methods in correct order', async () => {
    const scriptOutput = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "x", "passed": true, "reasoning": "ok" }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const bridge = makeBridge(scriptOutput);
    await validateInBrowser(
      'sess-42',
      { url: 'http://localhost:3000', checks: ['x'] },
      bridge as never,
    );

    // 1. LLM call to generate script
    expect(bridge.callReviewerModel).toHaveBeenCalledOnce();
    expect(bridge.callReviewerModel.mock.calls[0][0]).toBe('sess-42');

    // 2. Write script to container
    expect(bridge.writeFileInContainer).toHaveBeenCalledOnce();
    expect(bridge.writeFileInContainer.mock.calls[0][0]).toBe('sess-42');
    expect(bridge.writeFileInContainer.mock.calls[0][1]).toBe('/tmp/autopod-browser-check.mjs');

    // 3. mkdir, node execution, base64 screenshot
    expect(bridge.execInContainer).toHaveBeenCalledTimes(3);
  });

  it('handles screenshot collection failure gracefully', async () => {
    const scriptOutput = `__AUTOPOD_BROWSER_RESULTS_START__
[{ "check": "x", "passed": true, "reasoning": "ok" }]
__AUTOPOD_BROWSER_RESULTS_END__`;

    const bridge = {
      callReviewerModel: vi.fn().mockResolvedValue('script'),
      writeFileInContainer: vi.fn().mockResolvedValue(undefined),
      execInContainer: vi.fn().mockImplementation((_sid: string, cmd: string[]) => {
        if (cmd[0] === 'mkdir') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'node') {
          return Promise.resolve({ stdout: scriptOutput, stderr: '', exitCode: 0 });
        }
        // Screenshot fails
        return Promise.reject(new Error('file not found'));
      }),
    };

    const result = await validateInBrowser(
      'sess-1',
      { url: 'http://localhost:3000', checks: ['x'] },
      bridge as never,
    );

    const parsed = JSON.parse(result);
    expect(parsed.results[0].screenshot).toBeUndefined();
    expect(parsed.results[0].passed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { type PlaywrightScriptConfig, generateValidationScript } from './playwright-script.js';

function makeConfig(overrides: Partial<PlaywrightScriptConfig> = {}): PlaywrightScriptConfig {
  return {
    baseUrl: 'http://localhost:3000',
    pages: [{ path: '/', assertions: [] }],
    screenshotDir: '/tmp/screenshots',
    navigationTimeout: 10_000,
    maxConsoleErrors: 20,
    ...overrides,
  };
}

describe('generateValidationScript', () => {
  it('contains chromium import', () => {
    const script = generateValidationScript(makeConfig());
    expect(script).toContain("import { chromium } from 'playwright'");
  });

  it('bakes config as JSON constant', () => {
    const cfg = makeConfig({ baseUrl: 'http://example.com:8080' });
    const script = generateValidationScript(cfg);
    expect(script).toContain('const CONFIG = ');
    // The JSON should round-trip the baseUrl
    expect(script).toContain('http://example.com:8080');
  });

  it('has --no-sandbox launch arg', () => {
    const script = generateValidationScript(makeConfig());
    expect(script).toContain('--no-sandbox');
  });

  it('contains all page paths from config', () => {
    const cfg = makeConfig({
      pages: [{ path: '/dashboard' }, { path: '/settings' }, { path: '/users/123' }],
    });
    const script = generateValidationScript(cfg);
    // Paths are embedded via the JSON config blob
    expect(script).toContain('/dashboard');
    expect(script).toContain('/settings');
    expect(script).toContain('/users/123');
  });

  it('has screenshot directory creation', () => {
    const script = generateValidationScript(makeConfig());
    expect(script).toContain('mkdirSync');
    expect(script).toContain('CONFIG.screenshotDir');
    expect(script).toContain('recursive: true');
  });

  it('has marker strings for JSON output', () => {
    const script = generateValidationScript(makeConfig());
    expect(script).toContain('__AUTOPOD_PAGE_RESULTS_START__');
    expect(script).toContain('__AUTOPOD_PAGE_RESULTS_END__');
  });

  it('generates assertion handling code for each type', () => {
    const script = generateValidationScript(makeConfig());
    expect(script).toContain("case 'exists'");
    expect(script).toContain("case 'visible'");
    expect(script).toContain("case 'text_contains'");
    expect(script).toContain("case 'count'");
  });

  it('produces valid script with empty pages array', () => {
    const script = generateValidationScript(makeConfig({ pages: [] }));
    // Should still be a syntactically complete script
    expect(script).toContain("import { chromium } from 'playwright'");
    expect(script).toContain('__AUTOPOD_PAGE_RESULTS_START__');
    // Config should have an empty pages array
    expect(script).toContain('"pages":[]');
  });
});

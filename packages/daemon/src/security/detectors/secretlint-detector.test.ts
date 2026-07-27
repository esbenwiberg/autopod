import { describe, expect, it } from 'vitest';
import { createSecretlintDetector } from './secretlint-detector.js';

describe('secretlint-detector', () => {
  const detector = createSecretlintDetector();

  it('flags an AWS access key', async () => {
    // Synthetic AKIA-prefixed key; secretlint's preset ignores the documented
    // AWSAccessKeyID example string, so we use a non-canonical fixture.
    const fakeKey = ['AKIAQ4Z9PX', 'R7DNV3HM2L'].join('');
    const findings = await detector.scan({
      path: 'src/config.ts',
      content: `const key = '${fakeKey}';`,
      sizeBytes: 100,
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const aws = findings[0];
    expect(aws?.detector).toBe('secrets');
    expect(aws?.file).toBe('src/config.ts');
    expect(aws?.line).toBeGreaterThanOrEqual(1);
    expect(aws?.snippet).toMatch(/REDACTED/);
    // Snippet should NOT contain the raw key.
    expect(aws?.snippet).not.toContain(fakeKey);
  });

  it('returns an empty list for clean source', async () => {
    const findings = await detector.scan({
      path: 'src/clean.ts',
      content: 'export const greet = (name: string) => `hi ${name}`;',
      sizeBytes: 100,
    });
    expect(findings).toEqual([]);
  });

  it('keeps exact-match identities private and stable across line movement', async () => {
    const fakeKey = ['AKIAQ4Z9PX', 'R7DNV3HM2L'].join('');
    const before = {
      path: 'src/config.ts',
      content: `const key = '${fakeKey}';`,
      sizeBytes: 100,
    };
    const after = {
      ...before,
      content: `// formatting moved the declaration\n\nconst key = '${fakeKey}';`,
    };

    const firstInternal = await detector.scanWithBaselineIdentity?.(before);
    const movedInternal = await detector.scanWithBaselineIdentity?.(after);
    expect(firstInternal).toHaveLength(1);
    expect(movedInternal).toHaveLength(1);
    expect(firstInternal?.[0]?.identity).toBe(movedInternal?.[0]?.identity);
    expect(firstInternal?.[0]?.identity).not.toContain(fakeKey);

    const publicFindings = await detector.scan(after);
    const serialized = JSON.stringify(publicFindings);
    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain(firstInternal?.[0]?.identity ?? 'missing-identity');
    expect(Object.keys(publicFindings[0] ?? {})).not.toContain('identity');
  });

  it('does not throw on degenerate input', async () => {
    await expect(detector.scan({ path: 'empty.ts', content: '', sizeBytes: 0 })).resolves.toEqual(
      [],
    );
  });
});

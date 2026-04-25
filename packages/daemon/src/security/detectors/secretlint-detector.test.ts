import { describe, expect, it } from 'vitest';
import { createSecretlintDetector } from './secretlint-detector.js';

describe('secretlint-detector', () => {
  const detector = createSecretlintDetector();

  it('flags an AWS access key', async () => {
    // Synthetic AKIA-prefixed key; secretlint's preset ignores the documented
    // AWSAccessKeyID example string, so we use a non-canonical fixture.
    const fakeKey = 'AKIAQ4Z9PXR7DNV3HM2L';
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

  it('does not throw on degenerate input', async () => {
    await expect(detector.scan({ path: 'empty.ts', content: '', sizeBytes: 0 })).resolves.toEqual(
      [],
    );
  });
});

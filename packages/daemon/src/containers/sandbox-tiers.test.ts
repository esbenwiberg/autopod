import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_TIER,
  MAX_SANDBOX_MEMORY_BYTES,
  MAX_SANDBOX_TIER,
  parseSandboxDefaultTier,
  resolveSandboxTier,
  SANDBOX_TIERS,
  sandboxTierLabel,
  sandboxTierMemoryBytes,
  sandboxTierResources,
} from './sandbox-tiers.js';

const GB = 1024 * 1024 * 1024;

describe('sandbox tier catalog', () => {
  it('is ordered ascending and ends at 2XL without offering 3XL', () => {
    expect(SANDBOX_TIERS.map((t) => t.tier)).toEqual(['XS', 'S', 'M', 'L', 'XL', '2XL']);
    const memory = SANDBOX_TIERS.map((t) => t.memoryGiB);
    expect([...memory].sort((a, b) => a - b)).toEqual(memory);
    expect(MAX_SANDBOX_TIER).toBe('2XL');
    expect(MAX_SANDBOX_MEMORY_BYTES).toBe(16 * GB);
  });

  it('keeps the L default separate from the 2XL maximum', () => {
    expect(DEFAULT_SANDBOX_TIER).toBe('L');
    expect(DEFAULT_SANDBOX_TIER).not.toBe(MAX_SANDBOX_TIER);
  });

  it('keeps the existing XS–L Azure payloads byte-identical', () => {
    expect(sandboxTierResources('XS')).toEqual({ cpu: '250m', memory: '512Mi', disk: '5Gi' });
    expect(sandboxTierResources('S')).toEqual({ cpu: '500m', memory: '1024Mi', disk: '10Gi' });
    expect(sandboxTierResources('M')).toEqual({ cpu: '1000m', memory: '2048Mi', disk: '20Gi' });
    expect(sandboxTierResources('L')).toEqual({ cpu: '2000m', memory: '4096Mi', disk: '40Gi' });
  });

  it('derives the XL and 2XL Azure payloads from the catalog', () => {
    expect(sandboxTierResources('XL')).toEqual({ cpu: '4000m', memory: '8192Mi', disk: '80Gi' });
    expect(sandboxTierResources('2XL')).toEqual({
      cpu: '8000m',
      memory: '16384Mi',
      disk: '160Gi',
    });
  });

  it('labels each bundle with vCPU, RAM and disk', () => {
    expect(sandboxTierLabel('L')).toBe('L · 2 vCPU · 4 GiB RAM · 40 GiB disk');
    expect(sandboxTierLabel('XL')).toBe('XL · 4 vCPU · 8 GiB RAM · 80 GiB disk');
    expect(sandboxTierLabel('2XL')).toBe('2XL · 8 vCPU · 16 GiB RAM · 160 GiB disk');
    expect(sandboxTierLabel('XS')).toBe('XS · 0.25 vCPU · 0.5 GiB RAM · 5 GiB disk');
    expect(sandboxTierMemoryBytes('XL')).toBe(8 * GB);
  });
});

describe('resolveSandboxTier', () => {
  it('falls back to the configured default when no memory hint is given', () => {
    expect(resolveSandboxTier(undefined, 'L')).toBe('L');
    expect(resolveSandboxTier(0, 'M')).toBe('M');
    expect(resolveSandboxTier(-1, 'S')).toBe('S');
  });

  it('rounds up only within XS–L', () => {
    expect(resolveSandboxTier(256 * 1024 * 1024, 'L')).toBe('XS');
    expect(resolveSandboxTier(512 * 1024 * 1024, 'L')).toBe('XS');
    expect(resolveSandboxTier(768 * 1024 * 1024, 'L')).toBe('S');
    expect(resolveSandboxTier(1 * GB, 'L')).toBe('S');
    expect(resolveSandboxTier(1.5 * GB, 'XS')).toBe('M');
    expect(resolveSandboxTier(2 * GB, 'XS')).toBe('M');
    expect(resolveSandboxTier(3 * GB, 'XS')).toBe('L');
    expect(resolveSandboxTier(4 * GB, 'XS')).toBe('L');
  });

  it('selects XL and 2XL only for their exact RAM size', () => {
    expect(resolveSandboxTier(8 * GB, 'L')).toBe('XL');
    expect(resolveSandboxTier(16 * GB, 'L')).toBe('2XL');
  });

  it.each([
    5, 6, 10, 12, 16.5, 32, 64,
  ])('refuses %s GiB rather than rounding up or clamping', (gib) => {
    let error: unknown;
    try {
      resolveSandboxTier(gib * GB, 'L');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'PREFLIGHT_INSUFFICIENT_MEMORY', statusCode: 409 });
    expect(String((error as Error).message)).toContain(`requested ${gib} GiB`);
    expect(String((error as Error).message)).toContain('XL (8 GiB) or 2XL (16 GiB)');
  });
});

describe('parseSandboxDefaultTier', () => {
  it('accepts XS–L as the fleet default', () => {
    expect(parseSandboxDefaultTier(undefined)).toEqual({});
    expect(parseSandboxDefaultTier('')).toEqual({});
    for (const tier of ['XS', 'S', 'M', 'L'])
      expect(parseSandboxDefaultTier(tier)).toEqual({ tier });
  });

  it('treats opt-in XL/2XL like an unknown value, explaining they are per-repository', () => {
    for (const tier of ['XL', '2XL']) {
      const parsed = parseSandboxDefaultTier(tier);
      expect(parsed.tier).toBeUndefined();
      expect(parsed.warning).toContain('per-repository opt-in');
      expect(parsed.warning).toContain('expected XS, S, M, L');
    }
  });

  it('ignores unknown tiers including 3XL', () => {
    for (const value of ['3XL', 'huge', 'l']) {
      const parsed = parseSandboxDefaultTier(value);
      expect(parsed.tier).toBeUndefined();
      expect(parsed.warning).toBe('Ignoring invalid sandbox tier; expected XS, S, M, L');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { containerMemoryRequestBytes, resolveContainerMemory } from './container-memory.js';

const GB = 1024 ** 3;

describe('containerMemoryRequestBytes', () => {
  it('keeps the generic default on docker', () => {
    expect(containerMemoryRequestBytes(null, 'local')).toBe(10 * GB);
    expect(containerMemoryRequestBytes(undefined, 'local')).toBe(10 * GB);
    expect(containerMemoryRequestBytes(6, 'local')).toBe(6 * GB);
  });

  it('leaves an omitted sandbox size to the configured default bundle', () => {
    expect(containerMemoryRequestBytes(null, 'sandbox')).toBeUndefined();
    expect(containerMemoryRequestBytes(undefined, 'sandbox')).toBeUndefined();
  });

  it('never reinterprets an explicit or frozen sandbox size as omitted', () => {
    expect(containerMemoryRequestBytes(8, 'sandbox')).toBe(8 * GB);
    expect(containerMemoryRequestBytes(16, 'sandbox')).toBe(16 * GB);
    expect(containerMemoryRequestBytes(32, 'sandbox')).toBe(32 * GB);
    // An explicit 10 stays 10 so the resolver refuses it, rather than being
    // treated as omitted (default L) or rounded up to 2XL.
    expect(containerMemoryRequestBytes(10, 'sandbox')).toBe(10 * GB);
  });
});

describe('resolveContainerMemory', () => {
  it('honours the requested size on docker', () => {
    expect(resolveContainerMemory(10, 'local')).toMatchObject({ requestedGb: 10, grantedGb: 10 });
    expect(resolveContainerMemory(null, 'local')).toMatchObject({ requestedGb: 10, grantedGb: 10 });
  });

  it('reports no ceiling on docker when memory is uncapped', () => {
    expect(resolveContainerMemory(0, 'local').grantedGb).toBeNull();
  });

  it('maps a sandbox request to its bundle, rounding up only within XS–L', () => {
    expect(resolveContainerMemory(1.5, 'sandbox')).toMatchObject({
      requestedGb: 1.5,
      grantedGb: 2,
      sandboxTier: 'M',
    });
    expect(resolveContainerMemory(8, 'sandbox')).toMatchObject({
      grantedGb: 8,
      sandboxTier: 'XL',
      bundleLabel: 'XL · 4 vCPU · 8 GiB RAM · 80 GiB disk',
      unsupported: false,
    });
    expect(resolveContainerMemory(16, 'sandbox')).toMatchObject({
      grantedGb: 16,
      sandboxTier: '2XL',
    });
    expect(resolveContainerMemory(32, 'sandbox')).toMatchObject({
      grantedGb: 32,
      sandboxTier: '3XL',
      bundleLabel: '3XL · 16 vCPU · 32 GiB RAM · 320 GiB disk',
      unsupported: false,
    });
  });

  it('flags a non-bundle sandbox request above L as unsupported instead of clamping', () => {
    for (const gb of [10, 64])
      expect(resolveContainerMemory(gb, 'sandbox')).toMatchObject({
        requestedGb: gb,
        grantedGb: null,
        sandboxTier: null,
        unsupported: true,
      });
  });

  it('does not invent a number for an omitted sandbox size', () => {
    expect(resolveContainerMemory(null, 'sandbox')).toEqual({
      requestedGb: null,
      grantedGb: null,
      sandboxTier: null,
      bundleLabel: null,
      unsupported: false,
    });
  });
});

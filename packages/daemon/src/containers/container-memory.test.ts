import { describe, expect, it } from 'vitest';
import { MAX_SANDBOX_MEMORY_GB, resolveContainerMemory } from './container-memory.js';

describe('resolveContainerMemory', () => {
  it('honours the requested size on docker', () => {
    expect(resolveContainerMemory(10, 'local')).toEqual({
      requestedGb: 10,
      grantedGb: 10,
      clamped: false,
    });
  });

  it('clamps a request above the largest sandbox tier', () => {
    expect(resolveContainerMemory(10, 'sandbox')).toEqual({
      requestedGb: 10,
      grantedGb: MAX_SANDBOX_MEMORY_GB,
      clamped: true,
    });
  });

  it('clamps the daemon default on sandbox — the case nobody configured', () => {
    // An unset profile field is the common path, and the default (10 GB) is above
    // every published tier, so every default sandbox pod is silently downgraded.
    const resolved = resolveContainerMemory(null, 'sandbox');
    expect(resolved.grantedGb).toBe(MAX_SANDBOX_MEMORY_GB);
    expect(resolved.clamped).toBe(true);
  });

  it('rounds a sandbox request up to the smallest tier that satisfies it', () => {
    expect(resolveContainerMemory(1.5, 'sandbox')).toEqual({
      requestedGb: 1.5,
      grantedGb: 2,
      clamped: false,
    });
  });

  it('reports the platform ceiling when the request carries no hint', () => {
    expect(resolveContainerMemory(0, 'sandbox')).toEqual({
      requestedGb: 0,
      grantedGb: MAX_SANDBOX_MEMORY_GB,
      clamped: false,
    });
  });

  it('reports no ceiling on docker when memory is uncapped', () => {
    expect(resolveContainerMemory(0, 'local').grantedGb).toBeNull();
  });
});

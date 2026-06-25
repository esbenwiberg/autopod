import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTAINER_CPUS, resolveContainerNanoCpus } from './constants.js';

describe('resolveContainerNanoCpus', () => {
  it('falls back to the default when the env var is unset', () => {
    expect(resolveContainerNanoCpus(undefined)).toBe(DEFAULT_CONTAINER_CPUS * 1e9);
  });

  it('falls back to the default for empty / whitespace values', () => {
    expect(resolveContainerNanoCpus('')).toBe(DEFAULT_CONTAINER_CPUS * 1e9);
    expect(resolveContainerNanoCpus('   ')).toBe(DEFAULT_CONTAINER_CPUS * 1e9);
  });

  it('falls back to the default for unparseable values', () => {
    expect(resolveContainerNanoCpus('two')).toBe(DEFAULT_CONTAINER_CPUS * 1e9);
  });

  it('converts a whole-core value to NanoCpus', () => {
    expect(resolveContainerNanoCpus('4')).toBe(4 * 1e9);
  });

  it('supports fractional cores', () => {
    expect(resolveContainerNanoCpus('1.5')).toBe(1_500_000_000);
  });

  it('returns undefined (unbounded) for 0 or negative values', () => {
    expect(resolveContainerNanoCpus('0')).toBeUndefined();
    expect(resolveContainerNanoCpus('-1')).toBeUndefined();
  });

  it('honours an explicit default override', () => {
    expect(resolveContainerNanoCpus(undefined, 8)).toBe(8 * 1e9);
  });
});

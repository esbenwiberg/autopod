import { describe, expect, it } from 'vitest';
import { provisioningExecTimeout } from './provisioning-exec-timeout.js';

describe('provisioning exec timeout', () => {
  it.each([
    3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 100_000, 120_000,
  ])('adds only sandbox setup headroom to a %i ms local budget', (timeout) => {
    expect(provisioningExecTimeout('local', timeout)).toBe(timeout);
    expect(provisioningExecTimeout('sandbox', timeout)).toBe(Math.max(timeout, 60_000));
  });
});

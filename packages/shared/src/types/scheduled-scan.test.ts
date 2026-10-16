import { describe, expect, it } from 'vitest';
import { scheduledScanPolicyInputSchema, scheduledScanPolicySchema } from './scheduled-scan.js';

const sameBranch = {
  version: 1,
  baseRef: 'main',
  headRef: 'main',
  scanners: ['secrets'],
  judgment: 'none',
} as const;

describe('scheduled scan policy', () => {
  it('rejects identical refs without a window at the input boundary', () => {
    const result = scheduledScanPolicyInputSchema.safeParse(sameBranch);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('delta is always empty');
  });

  it('accepts identical refs with a window and distinct refs without one', () => {
    expect(
      scheduledScanPolicyInputSchema.safeParse({ ...sameBranch, windowHours: 24 }).success,
    ).toBe(true);
    expect(
      scheduledScanPolicyInputSchema.safeParse({ ...sameBranch, headRef: 'work' }).success,
    ).toBe(true);
  });

  it('keeps reading stored identical-ref policies so existing jobs and reports stay readable', () => {
    expect(scheduledScanPolicySchema.safeParse(sameBranch).success).toBe(true);
  });
});

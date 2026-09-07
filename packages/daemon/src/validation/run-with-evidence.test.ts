import { describe, expect, it, vi } from 'vitest';
import { runWithValidationEvidence } from './run-with-evidence.js';
import type {
  ValidationEvidenceCache,
  ValidationInputIdentity,
} from './validation-evidence-cache.js';

const identity: ValidationInputIdentity = {
  version: 1,
  hermetic: true,
  sourceTree: '1'.repeat(64),
  contract: '2'.repeat(64),
  toolchain: '3'.repeat(64),
  commands: '4'.repeat(64),
  dependencies: '5'.repeat(64),
  environment: '6'.repeat(64),
  implementation: '7'.repeat(64),
};
const reused = {
  status: 'pass' as const,
  duration: 0,
  output: '',
  reusedEvidence: {
    receiptId: 'receipt',
    identityHash: 'hash',
    originalPodId: 'original',
    originalExecutedAt: '2026-09-07',
    originalDurationMs: 100,
  },
};

describe('validation evidence race boundaries', () => {
  it('executes when inputs change during lookup and never records the changed result under the old identity', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValue({ ...identity, sourceTree: 'f'.repeat(64) });
    const cache: ValidationEvidenceCache = { get: vi.fn(() => reused), record: vi.fn() };
    const run = vi.fn(async () => ({ status: 'fail', duration: 1 }));
    expect(await runWithValidationEvidence('pod', 'test', run, cache, capture)).toEqual({
      status: 'fail',
      duration: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.record).not.toHaveBeenCalled();
  });

  it('does not seed evidence when the check changes its own inputs', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValue({ ...identity, dependencies: 'f'.repeat(64) });
    const cache: ValidationEvidenceCache = { get: vi.fn(() => null), record: vi.fn() };
    await runWithValidationEvidence(
      'pod',
      'lint',
      async () => ({ status: 'pass', duration: 1 }),
      cache,
      capture,
    );
    expect(cache.record).not.toHaveBeenCalled();
  });

  it('executes despite unavailable identity or corrupt cache and preserves actual failures', async () => {
    const cache: ValidationEvidenceCache = {
      get: vi.fn(() => {
        throw new Error('database unavailable');
      }),
      record: vi.fn(() => {
        throw new Error('write unavailable');
      }),
    };
    const run = vi.fn(async () => ({ status: 'fail', duration: 1 }));
    expect(
      await runWithValidationEvidence('pod', 'test', run, cache, async () => identity),
    ).toEqual({ status: 'fail', duration: 1 });
    expect(
      await runWithValidationEvidence('pod', 'test', run, cache, async () => {
        throw new Error('probe unavailable');
      }),
    ).toEqual({ status: 'fail', duration: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  captureSandboxCheckpointAuthority,
  unpublishedSandboxSourceBase,
} from './sandbox-checkpoint-policy.js';

type Source = Parameters<typeof unpublishedSandboxSourceBase>[0];
const base = 'a'.repeat(40);
const original: Source = {
  executionTarget: 'sandbox',
  lifecycleGeneration: 1,
  startCommitSha: base,
  status: 'running',
  validationAttempts: 0,
  reworkCount: 0,
  recoveryCount: 0,
  lastValidationResult: null,
  prUrl: null,
  linkedPodId: null,
  seriesId: null,
  skipAgent: false,
  options: { agentMode: 'auto', output: 'pr' },
  outputMode: 'pr',
};

describe('unpublished sandbox checkpoint source policy', () => {
  it.each([
    { validationAttempts: 1 },
    { prUrl: 'https://github.com/owner/repo/pull/1' },
    { lifecycleGeneration: 2 },
    { startCommitSha: 'b'.repeat(40) },
    { status: 'validating' },
  ] satisfies Partial<Source>[])('revokes captured rewrite authority across awaits: %j', async (change) => {
    let current = { ...original };
    const guard = captureSandboxCheckpointAuthority(original, () => current);
    guard();
    await Promise.resolve();
    current = { ...current, ...change };
    expect(guard).toThrow('eligibility changed');
  });
  it('preserves underlying custody/ownership refusal', () => {
    const guard = captureSandboxCheckpointAuthority(original, () => {
      throw new Error('Source custody changed');
    });
    expect(guard).toThrow('Source custody changed');
  });
  it('permits first-generation coding and explicit recovery of its failed capture', () => {
    expect(unpublishedSandboxSourceBase(original)).toBe(base);
    expect(unpublishedSandboxSourceBase({ ...original, status: 'failed' })).toBe(base);
    expect(
      unpublishedSandboxSourceBase({
        ...original,
        options: { agentMode: 'auto', output: 'branch' },
      }),
    ).toBe(base);
  });
  it.each([
    { executionTarget: 'local' },
    { lifecycleGeneration: 2 },
    { status: 'validated' },
    { status: 'validating' },
    { validationAttempts: 1 },
    { reworkCount: 1 },
    { recoveryCount: 1 },
    { startCommitSha: null },
    { startCommitSha: 'main' },
    { prUrl: 'https://github.com/owner/repo/pull/1' },
    { linkedPodId: 'parent' },
    { seriesId: 'series' },
    { skipAgent: true },
    { options: { agentMode: 'interactive', output: 'pr' } },
    { options: { agentMode: 'auto', output: 'artifact' } },
    { options: { agentMode: 'auto', output: 'none' } },
  ] satisfies Partial<Source>[])('retains strict ancestry when original coding eligibility is absent: %j', (changes) => {
    expect(unpublishedSandboxSourceBase({ ...original, ...changes })).toBeUndefined();
  });
});

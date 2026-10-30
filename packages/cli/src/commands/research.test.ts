import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerResearchCommands } from './research.js';

afterEach(() => vi.restoreAllMocks());
describe('findings acceptance command', () => {
  it('submits the exact reviewed generation, cycle and evidence without approval', async () => {
    const acceptFindings = vi.fn(async () => ({ acceptance: { acceptedAt: 'now' } }));
    const approveSession = vi.fn();
    const program = new Command().exitOverride();
    registerResearchCommands(
      program,
      () => ({ acceptFindings, approveSession }) as unknown as AutopodClient,
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'accept-findings',
      'full-pod-name',
      '--generation',
      '2',
      '--cycle',
      '3',
      '--evidence-hash',
      'a'.repeat(64),
    ]);
    expect(acceptFindings).toHaveBeenCalledExactlyOnceWith('full-pod-name', {
      expectedGeneration: 2,
      expectedCycle: 3,
      expectedEvidenceHash: 'a'.repeat(64),
    });
    expect(approveSession).not.toHaveBeenCalled();
  });
});

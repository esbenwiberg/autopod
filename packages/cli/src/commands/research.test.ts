import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerResearchCommands } from './research.js';

afterEach(() => vi.restoreAllMocks());
describe('findings acceptance command', () => {
  it('never selects unseen evidence for an archived report read', async () => {
    const getFindingsFile = vi.fn(async () => ({
      content: Buffer.from('retained report').toString('base64'),
      encoding: 'base64' as const,
    }));
    const acceptFindings = vi.fn();
    const client = { getFindingsFile, acceptFindings } as unknown as AutopodClient;
    const program = new Command().exitOverride();
    registerResearchCommands(program, () => client);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      program.parseAsync(['node', 'ap', 'findings', 'archived-pod', '--path', 'report.md']),
    ).rejects.toThrow('require --generation');
    expect(getFindingsFile).not.toHaveBeenCalled();
    const exact = new Command().exitOverride();
    registerResearchCommands(exact, () => client);
    await exact.parseAsync([
      'node',
      'ap',
      'findings',
      'archived-pod',
      '--generation',
      '2',
      '--cycle',
      '3',
      '--evidence-hash',
      'a'.repeat(64),
      '--path',
      'report.md',
    ]);
    expect(getFindingsFile).toHaveBeenCalledExactlyOnceWith(
      'archived-pod',
      2,
      3,
      'a'.repeat(64),
      'report.md',
    );
    expect(output).toHaveBeenCalledWith(Buffer.from('retained report'));
    expect(acceptFindings).not.toHaveBeenCalled();
  });
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

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerRetainedContinuationCommand } from './retained-continuation.js';

const client = {
  getCheckpointRecoveries: vi.fn(async () => ({ operations: [] })),
  continueRetained: vi.fn(async () => ({ operation: { id: 'stable-id' } })),
  checkRetainedCandidate: vi.fn(async () => ({ operation: { id: 'stable-id' } })),
  previewRetainedExecution: vi.fn(async () => ({ digest: 'd'.repeat(64) })),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerRetainedContinuationCommand(program, getClient);
  return program.parseAsync(['retained-continuation', 'retained-pod', ...args, '--json'], {
    from: 'user',
  });
}
const fields = [
  '--request-id',
  'stable-id',
  '--generation',
  '2',
  '--result-hash',
  'a'.repeat(64),
  '--reason',
  'Choose exact retained source for fresh independent checks',
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('retained continuation CLI', () => {
  it('inspects by default with no mutation or provider probe', async () => {
    await run();
    expect(client.getCheckpointRecoveries).toHaveBeenCalledWith('retained-pod');
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('previews replacement execution separately from admission', async () => {
    await run('--preview-execution', 'qualified-profile');
    expect(client.previewRetainedExecution).toHaveBeenCalledWith(
      'retained-pod',
      'qualified-profile',
    );
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('submits explicit independent source and execution selection without force authority', async () => {
    await run(
      '--apply',
      ...fields,
      '--head',
      'b'.repeat(40),
      '--remote-head',
      'c'.repeat(40),
      '--prepare-only',
      '--execution-profile',
      'qualified-profile',
      '--execution-digest',
      'd'.repeat(64),
    );
    expect(client.continueRetained).toHaveBeenCalledWith('retained-pod', {
      id: 'stable-id',
      expectedGeneration: 2,
      expectedResultHash: 'a'.repeat(64),
      checkpointHead: 'b'.repeat(40),
      remoteHead: 'c'.repeat(40),
      prepareOnly: true,
      executionProfileId: 'qualified-profile',
      expectedExecutionDigest: 'd'.repeat(64),
      reason: fields.at(-1),
    });
    expect(client.checkRetainedCandidate).not.toHaveBeenCalled();
  });
  it('selects an existing exact repaired candidate without relaunching preparation', async () => {
    await run('--check', ...fields, '--candidate-head', 'e'.repeat(40));
    expect(client.checkRetainedCandidate).toHaveBeenCalledWith('retained-pod', 'stable-id', {
      expectedGeneration: 2,
      expectedResultHash: 'a'.repeat(64),
      candidateHead: 'e'.repeat(40),
      reason: fields.at(-1),
    });
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('pairs a late execution preview with the exact candidate without repeating preparation', async () => {
    await run(
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--execution-profile',
      'qualified-profile',
      '--execution-digest',
      'd'.repeat(64),
    );
    expect(client.checkRetainedCandidate).toHaveBeenCalledWith('retained-pod', 'stable-id', {
      expectedGeneration: 2,
      expectedResultHash: 'a'.repeat(64),
      candidateHead: 'e'.repeat(40),
      executionProfileId: 'qualified-profile',
      expectedExecutionDigest: 'd'.repeat(64),
      reason: fields.at(-1),
    });
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it.each([
    ['--head', 'b'.repeat(40)],
    ['--apply'],
    ['--apply', '--check'],
    ['--apply', ...fields, '--head', 'main'],
    ['--apply', ...fields, '--head', 'b'.repeat(40), '--generation', 'NaN'],
    ['--apply', ...fields, '--head', 'b'.repeat(40), '--execution-profile', 'qualified'],
    ['--preview-execution', 'qualified', '--apply'],
    ['--check', ...fields, '--candidate-head', 'e'.repeat(40), '--execution-profile', 'qualified'],
    [
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--execution-digest',
      'd'.repeat(64),
    ],
    ['--check', ...fields, '--candidate-head', 'e'.repeat(40), '--remote-head', 'c'.repeat(40)],
  ])('rejects invalid or ambiguous selection before network access: %j', async (...args) => {
    await expect(run(...args)).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
  });
});

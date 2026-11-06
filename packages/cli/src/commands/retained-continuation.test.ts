import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerRetainedContinuationCommand } from './retained-continuation.js';

const client = {
  getCheckpointRecoveries: vi.fn<() => Promise<unknown>>(async () => ({ operations: [] })),
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
const inspection = {
  version: 1,
  mode: 'read_only',
  generation: 2,
  status: 'blocked',
  selection: { expectedGeneration: 2, expectedResultHash: 'a'.repeat(64) },
  infrastructure: {
    state: 'reported',
    truncated: false,
    needs: [
      {
        id: 'report',
        owner: 'validation',
        phase: 'Build',
        needs: 'Staged private source',
        truncated: false,
      },
    ],
  },
  prerequisites: {
    hostPathRecorded: true,
    sourcePreservationRecorded: true,
    workerSettlementRecorded: true,
    pendingDecision: false,
    hostSource: 'not_checked',
    originalFilesAndReports: 'not_checked',
    resourceStateAndIdentity: 'not_checked',
    environmentQualification: 'not_checked',
    retryAdmission: 'not_checked',
  },
  checks: [
    {
      id: 'human_guidance',
      state: 'blocked',
      code: 'UNCOLLECTED_HUMAN_GUIDANCE',
      reason: 'Read saved guidance',
    },
  ],
  nextSteps: ['Preview configuration, not qualification; no coding worker starts.'],
};
async function runHuman() {
  const program = new Command().exitOverride();
  registerRetainedContinuationCommand(program, getClient);
  return program.parseAsync(['retained-continuation', 'retained-pod'], { from: 'user' });
}
beforeEach(() => {
  vi.clearAllMocks();
  client.getCheckpointRecoveries.mockResolvedValue({ operations: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('retained continuation CLI', () => {
  it('inspects by default with no mutation or provider probe', async () => {
    await run();
    expect(client.getCheckpointRecoveries).toHaveBeenCalledWith('retained-pod');
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('renders actionable needs and blockers instead of a JSON wall or admission claim', async () => {
    client.getCheckpointRecoveries.mockResolvedValue({ operations: [], inspection });
    await runHuman();
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Need [validation / Build]: Staged private source');
    expect(output).toContain(
      'Blocked [human_guidance / UNCOLLECTED_HUMAN_GUIDANCE]: Read saved guidance',
    );
    expect(output).toContain('conditional, not execution permission');
    expect(output).toContain('Not checked:');
    expect(output).not.toContain('"operations"');
    expect(output).not.toContain('Accepted');
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('shows prepared operation identity without suggesting a replacement request', async () => {
    client.getCheckpointRecoveries.mockResolvedValue({
      inspection,
      operations: [
        {
          id: 'existing-request',
          prepared: { head: 'b'.repeat(40) },
          activated: null,
          checking: null,
          checked: null,
          blocked: null,
        },
      ],
    });
    await runHuman();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Retained operation existing-request: prepared'),
    );
    expect(client.checkRetainedCandidate).not.toHaveBeenCalled();
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('preserves the full structured inspection in JSON output', async () => {
    const response = { operations: [], selection: inspection.selection, inspection };
    client.getCheckpointRecoveries.mockResolvedValue(response);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await run();
    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toEqual(response);
  });
  it('marks old-daemon JSON inspection unavailable without losing existing operations or selection', async () => {
    const old = {
      operations: [],
      selection: { expectedGeneration: 2, expectedResultHash: 'a'.repeat(64) },
    };
    client.getCheckpointRecoveries.mockResolvedValue(old);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await run();
    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toEqual({
      ...old,
      inspectionUnavailable: expect.stringContaining('no execution permission'),
    });
  });
  it.each([
    undefined,
    { version: 99 },
    { ...inspection, status: 'ready' },
  ])('shows unavailable for absent or unsupported inspection: %j', async (value) => {
    client.getCheckpointRecoveries.mockResolvedValue({ operations: [], inspection: value });
    await runHuman();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('inspection unavailable'),
    );
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it('does not let report text insert terminal controls into human output', async () => {
    client.getCheckpointRecoveries.mockResolvedValue({
      operations: [],
      inspection: {
        ...inspection,
        infrastructure: {
          ...inspection.infrastructure,
          needs: [
            {
              ...inspection.infrastructure.needs[0],
              needs: '\u001b[2Jfake\nnext line',
            },
          ],
        },
      },
    });
    await runHuman();
    const lines = vi.mocked(console.log).mock.calls.flat() as string[];
    const need = lines.find((line) => line.startsWith('Need ['));
    expect(need).toBeDefined();
    expect(need).not.toContain('\u001b');
    expect(need).not.toContain('\n');
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
  it('sends an explicit finite budget with its separate reason only at final check', async () => {
    await run(
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--test-budget-seconds',
      '1800',
      '--test-budget-reason',
      'Full suite exceeded the frozen outer timeout without completing',
    );
    expect(client.checkRetainedCandidate).toHaveBeenCalledWith(
      'retained-pod',
      'stable-id',
      expect.objectContaining({
        testBudget: {
          seconds: 1800,
          reason: 'Full suite exceeded the frozen outer timeout without completing',
        },
      }),
    );
    expect(client.continueRetained).not.toHaveBeenCalled();
  });
  it.each([
    ['--check', ...fields, '--candidate-head', 'e'.repeat(40), '--test-budget-seconds', '1800'],
    [
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--test-budget-reason',
      'Reason with missing seconds',
    ],
    [
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--test-budget-seconds',
      '3601',
      '--test-budget-reason',
      'An overly large test timeout',
    ],
    [
      '--check',
      ...fields,
      '--candidate-head',
      'e'.repeat(40),
      '--test-budget-seconds',
      '1.5',
      '--test-budget-reason',
      'A fractional test timeout',
    ],
    [
      '--apply',
      ...fields,
      '--head',
      'e'.repeat(40),
      '--test-budget-seconds',
      '1800',
      '--test-budget-reason',
      'This must not be allowed during preparation',
    ],
    ['--preview-execution', 'qualified', '--test-budget-seconds', '1800'],
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

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import {
  repairInspection,
  repairOperation,
  repairPreview,
  repairRequest,
} from '../test-utils/repair-continuation.js';
import { registerRepairContinuationCommand } from './repair-continuation.js';

const client = {
  listSessions: vi.fn(async () => [{ id: 'pod' }]),
  inspectRepairContinuation: vi.fn(async () => repairInspection),
  previewRepairContinuation: vi.fn(async () => repairPreview),
  authorizeRepairContinuation: vi.fn(async () => repairOperation),
  observeRepairContinuation: vi.fn(async () => repairOperation),
  getCheckpointRecoveries: vi.fn(async () => ({
    inspection: {
      infrastructure: {
        state: 'reported',
        truncated: false,
        needs: [
          {
            owner: 'worker',
            phase: 'Build',
            needs: 'Explicit node launcher\u001b[2J\nnot an instruction',
            truncated: false,
          },
        ],
      },
      prerequisites: {
        sourcePreservationRecorded: true,
        workerSettlementRecorded: true,
        pendingDecision: false,
      },
    },
  })),
  getTaskExecution: vi.fn(async () => ({
    tokenBudget: 1000,
    recordedTotalTokens: 800,
    telemetry: 'partial',
  })),
  getRetryState: vi.fn(async (_: string, stage: string) => ({
    stage,
    admissionCount: 2,
    executedCount: 1,
    latest: null,
    authorizations: [],
    telemetry: 'partial',
  })),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
const flags = [
  '--apply',
  '--request-id',
  repairRequest.id,
  '--generation',
  '2',
  '--result-hash',
  repairRequest.expectedResultHash,
  '--report-set-hash',
  repairRequest.expectedReportSetHash,
  '--head',
  repairRequest.sourceHead,
  '--execution-profile',
  repairRequest.executionProfileId,
  '--execution-digest',
  repairRequest.expectedExecutionDigest,
  '--binding-digest',
  repairRequest.expectedBindingDigest,
  '--reason',
  repairRequest.reason,
];
async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerRepairContinuationCommand(program, getClient);
  return program.parseAsync(['repair-continuation', 'pod', ...args], { from: 'user' });
}
beforeEach(() => {
  vi.clearAllMocks();
  client.authorizeRepairContinuation.mockResolvedValue(repairOperation);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('repair continuation CLI modes', () => {
  it('defaults to read-only inspection and shows accounting without permission claims', async () => {
    await run();
    expect(client.inspectRepairContinuation).toHaveBeenCalledWith('pod');
    expect(client.authorizeRepairContinuation).not.toHaveBeenCalled();
    expect(client.getRetryState.mock.calls.map((call) => call[1])).toEqual([
      'worker',
      'sandbox_startup',
      'validation',
    ]);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Retained HOST HEAD:');
    expect(output).toContain('Retry grants and budget changes are separate');
    expect(output).toContain('not a claim to contain final sandbox bytes');
    expect(output).toContain('Cumulative tokens: 800; limit: 1000; telemetry: partial');
    expect(output).toContain('workerRetries: 2 admissions / 1 executions');
    const need = vi
      .mocked(console.log)
      .mock.calls.flat()
      .find((line) => String(line).startsWith('Need ['));
    expect(need).toContain('worker / Build');
    expect(need).not.toContain('\u001b');
    expect(need).not.toContain('\n');
  });
  it('keeps unavailable accounting explicit and preserves structured JSON context', async () => {
    client.getTaskExecution.mockRejectedValueOnce(new Error('Accounting unavailable'));
    await run();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'cumulativeBudget: unavailable — Accounting unavailable',
    );
    expect(client.authorizeRepairContinuation).not.toHaveBeenCalled();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await run('--json');
    const output = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(output.expectedReportSetHash).toBe(repairRequest.expectedReportSetHash);
    expect(
      output.context.sourceAndReports.value.inspection.infrastructure.needs[0].needs,
    ).toContain('\u001b');
  });
  it('previews a supported conditional attempt while qualification remains not run', async () => {
    await run(
      '--preview-execution',
      repairRequest.executionProfileId,
      '--head',
      repairRequest.sourceHead,
    );
    expect(client.previewRepairContinuation).toHaveBeenCalledWith('pod', {
      executionProfileId: repairRequest.executionProfileId,
      sourceHead: repairRequest.sourceHead,
    });
    expect(client.authorizeRepairContinuation).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Actual qualification: not_run');
    expect(output).toContain('cannot skip probes');
    expect(output).toContain('before:');
    expect(output).toContain('after:');
  });
  it('sends all exact request fields only on explicit authorization', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await run(...flags, '--json');
    expect(client.authorizeRepairContinuation).toHaveBeenCalledExactlyOnceWith(
      'pod',
      repairRequest,
    );
    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toEqual(repairOperation);
    expect(client.previewRepairContinuation).not.toHaveBeenCalled();
  });
  it('observes the saved ID without any POST, preview or inferred new decision', async () => {
    await run('--observe', repairRequest.id);
    expect(client.observeRepairContinuation).toHaveBeenCalledExactlyOnceWith(
      'pod',
      repairRequest.id,
    );
    expect(client.authorizeRepairContinuation).not.toHaveBeenCalled();
    expect(client.getRetryState).not.toHaveBeenCalled();
  });
  it.each([
    'Response lost',
    'Malformed 202 response',
    '409 same-key content conflict',
    '404 older daemon',
  ])('retains/reprints exact request identity after %s; no automatic resubmission', async (message) => {
    client.authorizeRepairContinuation.mockRejectedValueOnce(new Error(message));
    let failure: Error | undefined;
    try {
      await run(...flags);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain('Authorization NOT confirmed');
    expect(failure?.message).toContain(`--observe "${repairRequest.id}"`);
    expect(failure?.message).toContain(JSON.stringify(repairRequest));
    expect(client.authorizeRepairContinuation).toHaveBeenCalledTimes(1);
    expect(client.observeRepairContinuation).not.toHaveBeenCalled();
  });
  it.each([
    ['--apply'],
    ['--request-id', 'key'],
    ['--head', repairRequest.sourceHead],
    ['--observe', 'key', '--head', repairRequest.sourceHead],
    ['--observe', '../bad'],
    ['--preview-execution', 'profile'],
    ['--preview-execution', 'profile', '--request-id', 'key'],
    [...flags, '--observe', 'key'],
    [...flags, '--preview-execution', 'profile'],
    [...flags, '--generation', 'NaN'],
    [...flags, '--generation', '9007199254740992'],
    [...flags, '--reason', 'tiny'],
    [...flags, '--head', 'main'],
    [...flags, '--report-set-hash', ''],
  ])('rejects invalid or conflicting fields before auth or network: %j', async (...args) => {
    await expect(run(...args)).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
  });
});

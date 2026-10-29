import type { SourceAdoptionRequest, SourceAdoptionState } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { type AutopodClient, DaemonUnreachableError } from '../api/client.js';
import { registerSourceRecoveryCommand } from './source-recovery.js';
afterEach(() => vi.restoreAllMocks());
const request: SourceAdoptionRequest = {
  id: 'source-once',
  expectedGeneration: 3,
  oldHeadSha: 'a'.repeat(40),
  targetHeadSha: 'b'.repeat(40),
  dependencySetupCommand: 'npm ci',
  reason: 'Adopt exact repaired source without delivery',
};
const state: SourceAdoptionState = {
  id: request.id,
  podId: '12345678',
  generation: 3,
  oldHeadSha: request.oldHeadSha,
  targetHeadSha: request.targetHeadSha,
  stage: 'claimed',
  validation: 'pending',
  error: null,
  actor: { type: 'human', userId: 'operator' },
  reports: 'not-released',
  delivery: 'not-authorized',
};
function setup() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = {
    getSourceAdoptions: vi.fn(async () => ({ operations: [state] })),
    adoptSource: vi.fn(async (_id: string, _request: SourceAdoptionRequest) => state),
  };
  const program = new Command().exitOverride();
  registerSourceRecoveryCommand(program, () => client as unknown as AutopodClient);
  const parse = (...args: string[]) =>
    program.parseAsync(['source-recovery', '12345678', ...args], { from: 'user' });
  return { client, log, parse };
}
const flags = [
  '--request-id',
  request.id,
  '--generation',
  '3',
  '--old-head',
  request.oldHeadSha,
  '--head',
  request.targetHeadSha,
  '--setup',
  request.dependencySetupCommand,
  '--reason',
  request.reason,
];
it('inspects by default without a source mutation or automatic retry', async () => {
  const s = setup();
  await s.parse();
  expect(s.client.getSourceAdoptions).toHaveBeenCalledExactlyOnceWith('12345678');
  expect(s.client.adoptSource).not.toHaveBeenCalled();
  expect(s.log.mock.calls.flat().join('\n')).toContain('Delivery NOT authorized');
});
it('submits only the exact explicit typed source request and emits one JSON result', async () => {
  const s = setup();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await s.parse(...flags, '--json');
  expect(s.client.adoptSource).toHaveBeenCalledExactlyOnceWith('12345678', request);
  expect(stdout.mock.calls).toHaveLength(1);
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(state);
  expect(s.log).not.toHaveBeenCalled();
});
it.each([
  ['--head', request.targetHeadSha],
  ['--generation', '1x'],
  ['--request-id', 'other'],
])('rejects incomplete mutation %j before contacting the daemon', async (...args) => {
  const s = setup();
  await expect(s.parse(...args)).rejects.toThrow();
  expect(s.client.adoptSource).not.toHaveBeenCalled();
  expect(s.client.getSourceAdoptions).not.toHaveBeenCalled();
});
it('does not replay a lost mutation or suggest a replacement request ID', async () => {
  const s = setup();
  s.client.adoptSource.mockRejectedValue(new DaemonUnreachableError('https://daemon.invalid'));
  await expect(s.parse(...flags)).rejects.toThrow('outcome is unknown');
  expect(s.client.adoptSource).toHaveBeenCalledTimes(1);
});

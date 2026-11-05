import { Command } from 'commander';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerApprovalRewriteRepairCommand } from './approval-rewrite-repair.js';
const client = {
  getRewriteRepairs: vi.fn(async () => ({})),
  prepareRewriteRepair: vi.fn(async () => ({})),
  checkRewriteRepair: vi.fn(async () => ({})),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerApprovalRewriteRepairCommand(program, getClient);
  return program.parseAsync(['approval-rewrite-repair', 'whole-pod-id', ...args, '--json'], {
    from: 'user',
  });
}
const fields = [
  '--request-id',
  'repair',
  '--rewrite-id',
  'rewrite',
  '--failed-dispatch-id',
  'dispatch',
  '--generation',
  '2',
  '--result-hash',
  'a'.repeat(64),
  '--reason',
  'Select exact repair for fresh independent checks',
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it('inspects by default without resolving prefixes or mutating', async () => {
  await run();
  expect(client.getRewriteRepairs).toHaveBeenCalledWith('whole-pod-id');
  expect(client.prepareRewriteRepair).not.toHaveBeenCalled();
});
it('requires exact identities and explicit prepare or check', async () => {
  await expect(run(...fields)).rejects.toThrow('Choose exactly');
  await expect(run('--prepare', '--check', ...fields)).rejects.toThrow('Choose exactly');
  await expect(run('--prepare', ...fields, '--candidate-head', 'b'.repeat(40))).rejects.toThrow();
  expect(getClient).not.toHaveBeenCalled();
});
it('uses dedicated transports and propagates old-server failure without a fallback', async () => {
  await run('--prepare', ...fields, '--head', 'b'.repeat(40));
  expect(client.prepareRewriteRepair).toHaveBeenCalledWith(
    'whole-pod-id',
    expect.objectContaining({
      rewriteId: 'rewrite',
      failedDispatchId: 'dispatch',
      checkpointHead: 'b'.repeat(40),
    }),
  );
  client.checkRewriteRepair.mockRejectedValueOnce(new Error('HTTP 404: unsupported'));
  await expect(run('--check', ...fields, '--candidate-head', 'c'.repeat(40))).rejects.toThrow(
    '404',
  );
  expect(client.prepareRewriteRepair).toHaveBeenCalledTimes(1);
});

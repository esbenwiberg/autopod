import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const receipt = {
    podId: 'exact-pod',
    requestKey: 'decision-1',
    intent: 'kill',
    state: 'cleanup_pending',
  };
  const client = {
    getSession: vi.fn(async () => ({ id: 'exact-pod', lifecycleGeneration: 1 })),
    requestOperatorDisposal: vi.fn(async () => receipt),
    getOperatorDisposal: vi.fn(async () => ({ receipt })),
    observeOperatorDisposal: vi.fn(async () => receipt),
  };
  const program = new Command();
  program.exitOverride();
  registerPodCommands(program, () => client as unknown as AutopodClient);
  return { program, client, log };
}
it('uses exact Kill intent and retains a caller idempotency key without claiming killed', async () => {
  const f = fixture();
  await f.program.parseAsync(['kill', 'exact-pod', '--request-key', 'decision-1'], {
    from: 'user',
  });
  expect(f.client.requestOperatorDisposal).toHaveBeenCalledWith('exact-pod', {
    expectedGeneration: 1,
    intent: 'kill',
    requestKey: 'decision-1',
  });
  const output = f.log.mock.calls.flat().join(' ');
  expect(output).toContain('cleanup_pending');
  expect(output).not.toMatch(/pod.*killed\./i);
});
it('requires Delete loss acknowledgement and sends it only with Delete intent', async () => {
  const f = fixture();
  await expect(f.program.parseAsync(['delete', 'exact-pod'], { from: 'user' })).rejects.toThrow();
  expect(f.client.requestOperatorDisposal).not.toHaveBeenCalled();
  await f.program.parseAsync(
    ['delete', 'exact-pod', '--acknowledge-data-loss', '--request-key', 'decision-1'],
    { from: 'user' },
  );
  expect(f.client.requestOperatorDisposal).toHaveBeenCalledWith('exact-pod', {
    expectedGeneration: 1,
    intent: 'delete',
    requestKey: 'decision-1',
    acknowledgeDataLoss: true,
  });
});
it('reads receipt without mutation and refuses a prefix resolving to a different exact ID', async () => {
  const f = fixture();
  await f.program.parseAsync(['disposal', 'exact-pod'], { from: 'user' });
  expect(f.client.requestOperatorDisposal).not.toHaveBeenCalled();
  expect(f.client.observeOperatorDisposal).not.toHaveBeenCalled();
  await expect(f.program.parseAsync(['kill', 'exact'], { from: 'user' })).rejects.toThrow(
    /exact full/,
  );
});

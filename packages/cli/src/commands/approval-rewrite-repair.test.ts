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

it('sends targeted retry authority through the existing operation and never retries an old server without its target', async () => {
  const { AutopodClient } = await import('../api/client.js');
  const { registerPodCommands } = await import('./pod.js');
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ message: 'Unknown rewriteRepair authority' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const api = new AutopodClient({
    baseUrl: 'http://127.0.0.1:9999',
    getToken: async () => 'fixture-token',
  });
  const program = new Command().exitOverride();
  registerPodCommands(program, () => api);
  try {
    await expect(
      program.parseAsync(
        [
          'authorize-retry',
          'whole-pod-id',
          '--request-key',
          'targeted-retry',
          '--reason',
          'Authorize exactly this prepared repair source',
          '--rewrite-repair',
          'repair',
          '--candidate-head',
          'a'.repeat(40),
          '--candidate-tree',
          'b'.repeat(40),
          '--json',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: 'http://127.0.0.1:9999/pods/whole-pod-id/retry-authorizations',
      body: {
        requestKey: 'targeted-retry',
        reason: 'Authorize exactly this prepared repair source',
        rewriteRepair: {
          recoveryId: 'repair',
          candidateHead: 'a'.repeat(40),
          candidateTree: 'b'.repeat(40),
        },
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

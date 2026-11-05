import { createServer } from 'node:http';
import { Command } from 'commander';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerApprovalRewriteRepairCommand } from './approval-rewrite-repair.js';
import { registerPodCommands } from './pod.js';

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

it.each([
  ['--rewrite-repair', ''],
  ['--candidate-head', ''],
  ['--candidate-tree', ''],
  ['--rewrite-repair', '', '--candidate-head', '', '--candidate-tree', ''],
  ['--rewrite-repair', 'repair'],
  ['--candidate-head', 'a'.repeat(40)],
  ['--candidate-tree', 'b'.repeat(40)],
  ['--rewrite-repair', '', '--candidate-head', 'a'.repeat(40), '--candidate-tree', 'b'.repeat(40)],
  ['--rewrite-repair', 'repair', '--candidate-head', '', '--candidate-tree', 'b'.repeat(40)],
  ['--rewrite-repair', 'repair', '--candidate-head', 'a'.repeat(40), '--candidate-tree', ''],
  ['--rewrite-repair', ' ', '--candidate-head', 'a'.repeat(40), '--candidate-tree', 'b'.repeat(40)],
])('rejects incomplete or empty retry targets before creating any client: %j', async (...target) => {
  const program = new Command().exitOverride();
  registerPodCommands(program, getClient);
  await expect(
    program.parseAsync(
      [
        'authorize-retry',
        'whole-pod-id',
        '--request-key',
        'targeted-retry',
        '--reason',
        'Authorize exactly this prepared repair source',
        ...target,
      ],
      { from: 'user' },
    ),
  ).rejects.toThrow('Targeted rewrite retry requires');
  // In particular, an older daemon cannot receive a generic grant or fallback.
  expect(getClient).not.toHaveBeenCalled();
});

it.each([
  404, 201,
])('requires a confirmed targeted retry response without fallback, server status=%s', async (status) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    response.end(
      JSON.stringify(
        status === 404
          ? { message: 'Unsupported targeted retry route' }
          : { id: 'generic', stage: 'validation' },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const api = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
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
    expect(requests).toEqual([
      {
        url: '/pods/whole-pod-id/retry-authorizations/rewrite-repair',
        body: {
          requestKey: 'targeted-retry',
          reason: 'Authorize exactly this prepared repair source',
          rewriteRepair: {
            recoveryId: 'repair',
            candidateHead: 'a'.repeat(40),
            candidateTree: 'b'.repeat(40),
          },
        },
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { createServer } from 'node:http';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

it('exports a full pod file through the authenticated CLI without waking the worker', async () => {
  const requests: string[] = [];
  const report = '# Full report\nhttps://example.org/source\n'.repeat(100);
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe('Bearer existing-login');
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        path: 'research-output.md',
        content: report,
        size: Buffer.byteLength(report),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'existing-login',
  });
  const program = new Command().exitOverride();
  registerPodCommands(program, () => client);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await program.parseAsync([
      'node',
      'ap',
      'files',
      'awful-lemur',
      '--path',
      'research-output.md',
      '--json',
    ]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ content: report });
    expect(requests).toEqual(['GET /pods/awful-lemur/files/content?path=research-output.md']);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

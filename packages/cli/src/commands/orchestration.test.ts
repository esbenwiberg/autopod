import { once } from 'node:events';
import { createServer } from 'node:http';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerOrchestrationCommands } from './orchestration.js';

it('launches externally with no workflow overrides and never follows or retries a refused start', async () => {
  const requests: string[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push([req.method, req.url, req.headers.authorization, body].join(' '));
    res
      .writeHead(status, { 'Content-Type': 'application/json', location: '/unexpected' })
      .end('{"run":"example"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    getToken: async () => 'test-operator',
  });
  const print = vi.spyOn(console, 'log').mockImplementation(() => {});
  const cmd = (op: string, slot = 'inspection') => {
    const program = new Command();
    registerOrchestrationCommands(program, () => client);
    return program.parseAsync(['orchestration', op, slot], { from: 'user' });
  };
  try {
    for (const op of ['status', 'start', 'cancel', 'cleanup']) await cmd(op);
    await expect(cmd('start', '../other')).rejects.toThrow('Invalid orchestration slot');
    status = 401;
    await expect(cmd('start')).rejects.toThrow();
    status = 307;
    await expect(cmd('start')).rejects.toThrow();
    expect(requests).toEqual(
      ['GET status', 'POST start', 'POST cancel', 'POST cleanup', 'POST start', 'POST start'].map(
        (x) => {
          const [method, op] = x.split(' ');
          return `${method} /orchestration/runs/inspection/${op} Bearer test-operator `;
        },
      ),
    );
  } finally {
    print.mockRestore();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

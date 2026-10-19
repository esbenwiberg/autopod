import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { getToken } from '../auth/token-manager.js';
import * as config from '../config/config-store.js';
import { registerDaemonCommands } from './daemon.js';
vi.mock('../auth/token-manager.js', () => ({
  getToken: vi.fn(async () => {
    throw new Error('login-required');
  }),
}));
vi.mock('../config/config-store.js', () => ({ get: vi.fn(), set: vi.fn() }));
it('connects to public health before the first login without misreporting an outage', async () => {
  let received: { url?: string; authorization?: string } = {};
  const server = createServer((req, res) => {
    received = { url: req.url, authorization: req.headers.authorization };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', version: 'fixture' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const program = new Command();
    registerDaemonCommands(program);
    await program.parseAsync(['node', 'ap', 'connect', url]);
    expect(received).toEqual({ url: '/health', authorization: 'Bearer' });
    expect(config.set).toHaveBeenCalledWith('daemon', url);
    expect(getToken).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('Connected to daemon vfixture');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

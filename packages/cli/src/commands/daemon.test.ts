import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { getToken } from '../auth/token-manager.js';
import * as config from '../config/config-store.js';
import { formatNetworkCapacity, registerDaemonCommands } from './daemon.js';

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

it('ap health reads full diagnostics and warns about exhausted Docker network capacity', async () => {
  let receivedUrl: string | undefined;
  const server = createServer((req, res) => {
    receivedUrl = req.url;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'degraded',
        version: 'fixture',
        docker: {
          connected: true,
          networks: {
            checkedAt: '2026-01-01T00:00:00.000Z',
            severity: 'critical',
            addressPools: { source: 'builtin-default', capacity: 31, used: 31, free: 0 },
            podNetworks: {
              total: 30,
              retained: 26,
              attached: 4,
              unattached: 26,
              reclaimable: 0,
              unknown: 0,
            },
            reclaimableHeadroom: 0,
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const program = new Command();
    registerDaemonCommands(program);
    await program.parseAsync(['node', 'ap', 'health', '--url', url]);
    expect(receivedUrl).toBe('/health?detail=full');
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('CRITICAL');
    expect(output).toContain('30 autopod (26 retained, 4 attached, 0 reclaimable)');
    expect(output).toContain('31/31 pool subnets used (builtin-default)');
    expect(output).toContain('HOST_NETWORK_CAPACITY');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('formats network capacity only when the daemon reports it', () => {
  expect(formatNetworkCapacity({ status: 'ok', version: 'old' })).toBeNull();
  expect(
    formatNetworkCapacity({ status: 'ok', version: 'x', docker: { networks: { error: 'nope' } } }),
  ).toContain('unavailable');
});

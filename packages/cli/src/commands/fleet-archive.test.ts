import { createServer } from 'node:http';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
  }),
}));

describe('legacy fleet archives', () => {
  it.each([
    ['archive', '--reason', 'A meaningful reason'],
    ['archive-handled-elsewhere', '--generation', '1', '--status', 'paused'],
  ])('refuses the retired command %s locally', async (command, ...options) => {
    const program = new Command().exitOverride();
    const getClient = vi.fn(() => {
      throw new Error('A retired command must not contact any daemon');
    });
    registerPodCommands(program, getClient);
    expect(program.helpInformation()).not.toMatch(/^\s+archive(?:-handled-elsewhere)?\s/m);
    await expect(
      program.parseAsync(['node', 'ap', command, 'held-pod', ...options]),
    ).rejects.toThrow('Creating new fleet archives is retired');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('lists and restores existing archives without calling execution controls', async () => {
    const requests: { method: string; url: string }[] = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      res.setHeader('content-type', 'application/json');
      res.end(req.method === 'GET' ? '[]' : '{"fleetArchivedAt":null,"retainedResources":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const client = new AutopodClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      getToken: async () => 'synthetic',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerPodCommands(program, () => client);
      await program.parseAsync(['node', 'ap', ...args]);
    };
    try {
      await run('unarchive', 'blocked-catfish');
      await run('ls', '--archived', '--json');
      await run('ls', '--include-archived', '--compact', '--json');
      expect(requests).toEqual([
        { method: 'DELETE', url: '/pods/blocked-catfish/archive' },
        { method: 'GET', url: '/pods?archive=only' },
        { method: 'GET', url: '/pods?compact=true&archive=include' },
      ]);
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

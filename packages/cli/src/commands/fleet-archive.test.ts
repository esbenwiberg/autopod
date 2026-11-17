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

describe('fleet archive CLI transport', () => {
  it.each([
    200, 404,
  ])('uses only the explicit handled-elsewhere endpoint and never falls back (%s)', async (statusCode) => {
    const requests: { url: string; body: unknown }[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      requests.push({ url: req.url ?? '', body: JSON.parse(body) });
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          statusCode === 200
            ? { fleetArchivedAt: '2026-11-17T00:00:00Z', retainedResources: true }
            : { error: 'Unsupported control' },
        ),
      );
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
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerPodCommands(program, () => client);
      await program.parseAsync([
        'node',
        'ap',
        'archive-handled-elsewhere',
        'held-pod',
        '--generation',
        '1',
        '--status',
        'paused',
        '--reason',
        'Manually delivered; retain all original evidence',
        '--reference',
        'https://github.com/example/repo/pull/1',
        ...args,
      ]);
    };
    try {
      await expect(run()).rejects.toThrow();
      expect(requests).toHaveLength(0);
      if (statusCode === 200) await run('--ack-retained-execution', '--json');
      else await expect(run('--ack-retained-execution', '--json')).rejects.toThrow();
      expect(requests).toEqual([
        {
          url: '/pods/held-pod/archive-handled-elsewhere',
          body: {
            expectedGeneration: 1,
            expectedStatus: 'paused',
            reason: 'Manually delivered; retain all original evidence',
            reference: 'https://github.com/example/repo/pull/1',
            retainResources: true,
            acknowledgement: 'visibility-only-unknown-execution-retained',
          },
        },
      ]);
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses only metadata endpoints and explicitly acknowledges retention; lists archived pods on request', async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: body ? JSON.parse(body) : null,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        req.method === 'GET'
          ? '[]'
          : JSON.stringify({
              fleetArchivedAt: req.method === 'POST' ? '2026-11-01T12:00:00Z' : null,
              retainedResources: true,
            }),
      );
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
      await run(
        'archive',
        'blocked-catfish',
        '--reason',
        'Retain source and reports but hide the card',
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('execution may remain active and incur costs'),
      );
      await run('unarchive', 'blocked-catfish');
      await run('ls', '--archived', '--json');
      await run('ls', '--include-archived', '--compact', '--json');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/pods/blocked-catfish/archive',
          body: { reason: 'Retain source and reports but hide the card', retainResources: true },
        },
        { method: 'DELETE', url: '/pods/blocked-catfish/archive', body: null },
        { method: 'GET', url: '/pods?archive=only', body: null },
        { method: 'GET', url: '/pods?compact=true&archive=include', body: null },
      ]);
      await expect(run('archive', 'blocked-catfish', '--reason', 'short')).rejects.toThrow(
        '10–4000',
      );
      expect(requests).toHaveLength(4);
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

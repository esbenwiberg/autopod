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

describe('guarded CLI operator actions', () => {
  it.each([
    200, 404,
  ])('uses only versioned guarded endpoints (HTTP %s), with no legacy fallback', async (status) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push({ url: request.url ?? '', body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      response.statusCode = status;
      response.end(
        JSON.stringify(
          status === 200
            ? { ok: true, action: 'reply', expectedTarget: 'a'.repeat(64) }
            : { error: 'NOT_FOUND', message: 'Unsupported guarded interface' },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const client = new AutopodClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      getToken: async () => 'synthetic',
    });
    const program = new Command().exitOverride();
    registerPodCommands(program, () => client);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const call = program.parseAsync([
        'node',
        'ap',
        'tell',
        'fixture-pod',
        'Use v2',
        '--expected-target',
        'a'.repeat(64),
        '--actor',
        'parent-session',
        '--json',
      ]);
      if (status === 200) await call;
      else await expect(call).rejects.toThrow();
      expect(requests).toEqual([
        {
          url: '/pods/fixture-pod/operator-action-v1',
          body: {
            action: 'reply',
            expectedTarget: 'a'.repeat(64),
            actor: 'parent-session',
            message: 'Use v2',
          },
        },
      ]);
    } finally {
      log.mockRestore();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
  it('rejects malformed guards and bulk/waiver flags before network mutations', async () => {
    const action = vi.fn(),
      client = { guardedOperatorAction: action } as unknown as AutopodClient;
    for (const args of [
      ['tell', 'fixture-pod', 'answer', '--expected-target', 'bad', '--actor', 'parent'],
      [
        'approve',
        'fixture-pod',
        '--expected-target',
        'a'.repeat(64),
        '--actor',
        'parent',
        '--all-validated',
      ],
    ]) {
      const program = new Command().exitOverride();
      registerPodCommands(program, () => client);
      await expect(program.parseAsync(['node', 'ap', ...args])).rejects.toThrow();
    }
    expect(action).not.toHaveBeenCalled();
  });
});

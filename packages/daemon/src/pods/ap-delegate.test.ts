import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The worker CLI is intentionally a standalone JavaScript executable.
import { DESCRIPTOR_PATH, parseCommand, runDelegate } from './runtime/ap-delegate.mjs';

const config = {
  url: 'http://daemon.invalid/mcp/parent-1',
  authorization: 'Bearer fixture-secret',
};

function capture() {
  let value = '';
  return {
    stream: { write: (chunk: string) => (value += chunk) },
    text: () => value,
    json: () => JSON.parse(value) as Record<string, unknown>,
  };
}

function toolResponse(value: unknown, contentType = 'application/json') {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
}

async function run(
  argv: string[],
  transport: (url: string, init: RequestInit) => Promise<Response>,
) {
  const stdout = capture();
  const stderr = capture();
  const code = await runDelegate(argv, {
    config,
    transport,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout, stderr };
}

describe('restricted delegate CLI', () => {
  it('uses only the fixed descriptor path and rejects generic configuration surfaces', async () => {
    expect(DESCRIPTOR_PATH).toBe('/run/autopod/delegate.json');
    expect(() => parseCommand(['status'])).toThrow('only the delegate namespace');
    expect(() => parseCommand(['delegate', 'status', '--url', 'http://attacker.invalid'])).toThrow(
      'status accepts no options',
    );
    expect(() => parseCommand(['delegate', 'results', '--from', 'cursor'])).toThrow(
      'unsupported or repeated option',
    );
    for (const ms of ['0', '15001']) {
      expect(() => parseCommand(['delegate', 'wait', '--timeout-ms', ms])).toThrow(
        '--timeout-ms is out of range',
      );
    }
  });

  it('validates the optional ordered result cursor list on start', () => {
    expect(
      parseCommand([
        'delegate',
        'start',
        '--key',
        'stable',
        '--recipe',
        'inspect',
        '--brief',
        'Inspect prior results',
      ]),
    ).toEqual({
      kind: 'start',
      requestKey: 'stable',
      recipe: 'inspect',
      brief: 'Inspect prior results',
    });
    expect(
      parseCommand([
        'delegate',
        'start',
        '--key',
        'stable',
        '--recipe',
        'inspect',
        '--brief',
        'Inspect prior results',
        '--from',
        '9,2,7',
      ]),
    ).toEqual({
      kind: 'start',
      requestKey: 'stable',
      recipe: 'inspect',
      brief: 'Inspect prior results',
      from: [9, 2, 7],
    });

    for (const from of ['', '0', '1,1', '1,2,3,4,5', '1, 2', '9007199254740992']) {
      expect(() =>
        parseCommand([
          'delegate',
          'start',
          '--key',
          'stable',
          '--recipe',
          'inspect',
          '--brief',
          'Inspect prior results',
          '--from',
          from,
        ]),
      ).toThrow();
    }
    expect(() =>
      parseCommand([
        'delegate',
        'start',
        '--key',
        'stable',
        '--recipe',
        'inspect',
        '--brief',
        'Inspect prior results',
        '--from',
        '1',
        '--from',
        '2',
      ]),
    ).toThrow('unsupported or repeated option');
  });

  it.each([
    {
      argv: ['delegate', 'status'],
      name: 'managed_family',
      args: {},
      reply: { parent: 'parent-1', children: [] },
    },
    {
      argv: ['delegate', 'results', '--after', '7'],
      name: 'managed_results',
      args: { after: 7 },
      reply: { after: 7, results: [] },
    },
    {
      argv: ['delegate', 'wait', '--after', '4', '--timeout-ms', '15000'],
      name: 'managed_wait',
      args: { after: 4, timeoutMs: 15000 },
      reply: { after: 4, results: [] },
    },
  ])('maps $name to one bounded JSON-RPC tools/call', async ({ argv, name, args, reply }) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await run(argv, async (url, init) => {
      calls.push({ url, init });
      return toolResponse(reply);
    });

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(config.url);
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(calls[0]?.init.headers).toEqual({
      authorization: config.authorization,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(result.stdout.json()).toEqual({ ok: true, command: argv[1], result: reply });
    expect(result.stderr.text()).toBe('');
  });

  it('maps start and emits only its cheap family receipt matched by the stable request key', async () => {
    const family = {
      parent: 'parent-1',
      run: 'run-1',
      children: [
        { requestKey: 'other', child: 'managed-0', status: 'started' },
        { requestKey: 'stable_key', child: 'managed-1', status: 'reserved' },
      ],
    };
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).params).toEqual({
        name: 'managed_child_request',
        arguments: {
          requestKey: 'stable_key',
          recipe: 'inspect',
          brief: 'Read the pinned source',
        },
      });
      return toolResponse(family);
    });

    const result = await run(
      [
        'delegate',
        'start',
        '--key',
        'stable_key',
        '--recipe',
        'inspect',
        '--brief',
        'Read the pinned source',
      ],
      transport,
    );

    expect(result.code).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.stdout.json()).toEqual({
      ok: true,
      command: 'start',
      result: { requestKey: 'stable_key', child: 'managed-1', status: 'reserved' },
    });
  });

  it('preserves ordered start cursors in the single request', async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).params).toEqual({
        name: 'managed_child_request',
        arguments: {
          requestKey: 'stable_from',
          recipe: 'inspect',
          brief: 'Use selected results',
          from: [8, 3, 5],
        },
      });
      return toolResponse({
        children: [{ requestKey: 'stable_from', child: 'managed-2', status: 'reserved' }],
      });
    });

    const result = await run(
      [
        'delegate',
        'start',
        '--key',
        'stable_from',
        '--recipe',
        'inspect',
        '--brief',
        'Use selected results',
        '--from',
        '8,3,5',
      ],
      transport,
    );

    expect(result.code).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('accepts one standard SSE result event', async () => {
    const envelope = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"parent":"parent-1","children":[]}' }] },
    });
    const result = await run(
      ['delegate', 'status'],
      async () =>
        new Response(`event: message\ndata: ${envelope}\n\n`, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout.json()).toEqual({
      ok: true,
      command: 'status',
      result: { parent: 'parent-1', children: [] },
    });
  });

  it('never retries an uncertain start and gives sanitized exact-key reconciliation guidance', async () => {
    const transport = vi.fn(async () => {
      throw new Error(
        'socket failed with Authorization: Bearer fixture-secret at http://daemon.invalid/mcp/parent-1',
      );
    });
    const result = await run(
      ['delegate', 'start', '--key', 'stable-1', '--recipe', 'inspect', '--brief', 'Inspect once'],
      transport,
    );

    expect(result.code).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.stdout.text()).toBe('');
    expect(result.stderr.text()).not.toContain('fixture-secret');
    expect(result.stderr.text()).not.toContain('daemon.invalid');
    expect(result.stderr.json()).toEqual({
      ok: false,
      error: {
        code: 'TRANSPORT_ERROR',
        message: 'delegate transport failed',
        uncertain: true,
        requestKey: 'stable-1',
        reconcile:
          'Run "ap delegate status" and reuse the exact stable key "stable-1"; do not create a new key or auto-retry.',
      },
    });
  });

  it('does not assume a tool error occurred before durable admission', async () => {
    const result = await run(
      [
        'delegate',
        'start',
        '--key',
        'stable-error',
        '--recipe',
        'inspect',
        '--brief',
        'Inspect once',
      ],
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } }),
        ),
    );
    expect(result.code).toBe(1);
    expect(result.stderr.json()).toMatchObject({
      error: { code: 'REMOTE_ERROR', uncertain: true, requestKey: 'stable-error' },
    });
  });

  it('treats a successful start reply without the matching receipt as uncertain', async () => {
    const result = await run(
      ['delegate', 'start', '--key', 'stable-2', '--recipe', 'inspect', '--brief', 'Inspect once'],
      async () => toolResponse({ parent: 'parent-1', children: [] }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr.json()).toMatchObject({
      error: { code: 'START_UNCERTAIN', uncertain: true, requestKey: 'stable-2' },
    });
  });

  it('rejects multiple SSE events and oversized responses without exposing response content', async () => {
    const multiple = await run(
      ['delegate', 'status'],
      async () =>
        new Response('data: {}\n\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(multiple.code).toBe(1);
    expect(multiple.stderr.json()).toMatchObject({ error: { code: 'RESPONSE_INVALID' } });

    const oversized = await run(
      ['delegate', 'status'],
      async () =>
        new Response('sensitive body', {
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
    );
    expect(oversized.code).toBe(1);
    expect(oversized.stderr.text()).not.toContain('sensitive body');
    expect(oversized.stderr.json()).toMatchObject({ error: { code: 'RESPONSE_TOO_LARGE' } });
  });
});

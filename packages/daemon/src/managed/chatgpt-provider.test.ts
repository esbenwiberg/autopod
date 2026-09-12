import { expect, it, vi } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { type ChatGptFailureDiagnostic, ChatGptReportTransport } from './chatgpt-provider.js';
function setup() {
  const f = fixture();
  const route = f.request.route;
  f.close();
  const credential = vi.fn(async () => ({
    mode: 'chatgpt' as const,
    accountId: route.providerAccountId,
    chatgptAccountId: 'account-one',
    token: 'fixture-only',
  }));
  const response = {
    model: route.model,
    status: 'completed',
    usage: { input_tokens: 5000, output_tokens: 10, total_tokens: 5010 },
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Facts.' }] },
    ],
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  const diagnostic = vi.fn<(value: ChatGptFailureDiagnostic) => void>();
  const transport = new ChatGptReportTransport(
    route,
    'account-one',
    credential,
    fetcher,
    diagnostic,
  );
  const raw = JSON.stringify({
    model: route.model,
    input: [{ role: 'user', content: 'Fact' }],
    reasoning: { effort: route.reasoning },
    stream: true,
    store: false,
  });
  const call = () => transport.generate(route, raw, 0, new AbortController().signal, () => {});
  return { route, credential, response, fetcher, transport, raw, call, diagnostic };
}
it('uses exactly one pinned ChatGPT request and reports real returned usage without a hard cap', async () => {
  const x = setup();
  expect((await x.call()).consumedTokens).toBe(5010);
  expect(x.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = x.fetcher.mock.calls[0] ?? [];
  expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(init?.redirect).toBe('error');
  const body = JSON.parse(String(init?.body));
  expect(body.max_output_tokens).toBeUndefined();
  expect(body.tools).toEqual([]);
  expect(body.store).toBe(false);
});

it('returns validated tool-call SSE unchanged for the explicit agent transport', async () => {
  const x = setup();
  const functionCall = {
    id: 'call-item',
    type: 'function_call',
    call_id: 'call-one',
    name: 'shell',
    arguments: '{"command":"pwd"}',
    status: 'completed',
  };
  x.response.output = [functionCall] as never;
  const body = `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: functionCall })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`;
  x.fetcher.mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );
  const result = await agent.generate(
    x.route,
    JSON.stringify({
      model: x.route.model,
      input: [{ role: 'user', content: 'Inspect.' }],
      reasoning: { effort: x.route.reasoning },
      tools: [{ type: 'function', name: 'shell', parameters: {} }],
      stream: true,
      store: false,
    }),
    0,
    new AbortController().signal,
    () => {},
  );
  expect(result.value).toBe(body);
  expect(result.consumedTokens).toBe(5010);
  expect(agent.maximumPromptBytes).toBe(8 * 1024 * 1024);
  expect(x.transport.maximumPromptBytes).toBe(128 * 1024);
});
it('returns a validated agent SSE transcript larger than the report wire bound', async () => {
  const x = setup();
  const delta = {
    type: 'response.output_text.delta',
    item_id: 'message-one',
    output_index: 0,
    content_index: 0,
    delta: 'x'.repeat(70 * 1024),
  };
  const body = `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`;
  x.fetcher.mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );
  const result = await agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {});
  expect(Buffer.byteLength(result.value)).toBeGreaterThan(64 * 1024);
  expect(result.value).toBe(body);
  expect(agent.maximumResponseBytes).toBe(8 * 1024 * 1024);
});
it('returns a validated agent SSE transcript larger than one MiB', async () => {
  const x = setup();
  const delta = {
    type: 'response.output_text.delta',
    item_id: 'message-one',
    output_index: 0,
    content_index: 0,
    delta: 'x'.repeat(1024 * 1024),
  };
  const body = `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`;
  x.fetcher.mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );
  const result = await agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {});
  expect(result.value).toBe(body);
  expect(agent.maximumResponseBytes).toBe(8 * 1024 * 1024);
});
it('rejects an agent SSE transcript above the eight MiB hard ceiling', async () => {
  const x = setup();
  x.fetcher.mockResolvedValue(
    new Response(`data: ${'x'.repeat(8 * 1024 * 1024)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );
  await expect(
    agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {}),
  ).rejects.toThrow('managed-chatgpt-request-unavailable');
  expect(x.diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'stream',
    reason: 'response-limit',
    httpStatus: 200,
  });
});
it.each(['identity', 'mode', 'token'])('rejects credential %s before HTTP', async (kind) => {
  const x = setup();
  const c = await x.credential();
  if (kind === 'identity') c.chatgptAccountId = 'other';
  if (kind === 'mode') Object.assign(c, { mode: 'api-key' });
  if (kind === 'token') c.token = 'bad\nvalue';
  x.credential.mockResolvedValue(c);
  await expect(x.call()).rejects.toThrow('unavailable');
  expect(x.fetcher).not.toHaveBeenCalled();
});
it.each(['tool', 'usage', 'missing-usage', 'model', 'duplicate', 'failure', 'oversize', 'http'])(
  'rejects %s output without retry or leaking errors',
  async (kind) => {
    const x = setup();
    if (kind === 'tool')
      Object.assign(x.response, { output: [{ type: 'function_call', name: 'evil' }] });
    if (kind === 'usage') x.response.usage.total_tokens = 1;
    if (kind === 'missing-usage') Object.assign(x.response, { usage: null });
    if (kind === 'model') x.response.model = 'other';
    if (kind === 'oversize') x.response.output[0]!.content[0]!.text = 'x'.repeat(16385);
    if (['duplicate', 'failure', 'http'].includes(kind))
      x.fetcher.mockImplementation(
        async () =>
          new Response(
            kind === 'http'
              ? 'secret-error'
              : `data: ${JSON.stringify({ type: kind === 'failure' ? 'response.failed' : 'response.completed', response: x.response })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`,
            {
              status: kind === 'http' ? 401 : 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
      );
    await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
    expect(x.fetcher).toHaveBeenCalledTimes(1);
    const phases: Record<string, string> = {
      tool: 'response-schema',
      usage: 'usage',
      'missing-usage': 'response-schema',
      model: 'model',
      duplicate: 'stream',
      failure: 'stream',
      oversize: 'artifact',
      http: 'http',
    };
    expect(x.diagnostic.mock.calls[0]?.[0].phase).toBe(phases[kind]);
    expect(JSON.stringify(x.diagnostic.mock.calls)).not.toContain('secret-error');
  },
);
it('rejects revoked authority and wrong token mode before credential resolution', async () => {
  const x = setup();
  await expect(
    x.transport.generate(x.route, x.raw, 4096, new AbortController().signal, () => {}),
  ).rejects.toThrow('budget-mode');
  await expect(
    x.transport.generate(x.route, x.raw, 0, new AbortController().signal, () => {
      throw Error('revoked');
    }),
  ).rejects.toThrow('unavailable');
  expect(x.credential).not.toHaveBeenCalled();
});

it('failure diagnostics never retain a transport error payload or change failure semantics', async () => {
  const x = setup();
  x.fetcher.mockRejectedValue(new Error('Bearer fixture-secret-account-data'));
  x.diagnostic.mockImplementation(() => {
    throw new Error('observer-error');
  });
  await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
  expect(x.diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'http',
    reason: 'unclassified',
    httpStatus: null,
  });
  expect(x.fetcher).toHaveBeenCalledTimes(1);
});
it('successful generation does not emit failure diagnostics', async () => {
  const x = setup();
  await x.call();
  expect(x.diagnostic).not.toHaveBeenCalled();
});

it('validates the full bounded stream when the pinned endpoint omits Content-Type', async () => {
  const x = setup();
  x.fetcher.mockImplementation(async () => {
    const response = new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`,
    );
    response.headers.delete('content-type');
    return response;
  });
  expect((await x.call()).consumedTokens).toBe(5010);
  expect(x.fetcher).toHaveBeenCalledTimes(1);
});
it.each(['html', 'json', 'incomplete', 'model', 'missing-usage', 'duplicate'])(
  'missing Content-Type still rejects %s without fallback or retry',
  async (kind) => {
    const x = setup();
    if (kind === 'model') x.response.model = 'other';
    if (kind === 'missing-usage') Object.assign(x.response, { usage: null });
    let body = `data: ${JSON.stringify({ type: kind === 'incomplete' ? 'response.incomplete' : 'response.completed', response: x.response })}\n\n`;
    if (kind === 'html') body = '<html>not a response</html>';
    if (kind === 'json') body = JSON.stringify(x.response);
    if (kind === 'duplicate') body += body;
    x.fetcher.mockImplementation(async () => {
      const response = new Response(body);
      response.headers.delete('content-type');
      return response;
    });
    await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
    expect(x.fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(['application/json', 'text/html', 'text/event-stream-malformed', ''])(
  'rejects declared incompatible media type %s even with a completed SSE body',
  async (type) => {
    const x = setup();
    x.fetcher.mockImplementation(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`,
          { headers: { 'content-type': type } },
        ),
    );
    await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
    expect(x.diagnostic.mock.calls[0]?.[0].phase).toBe('http');
    expect(x.diagnostic.mock.calls[0]?.[0].httpStatus).toBe(200);
  },
);
it('accepts case-insensitive SSE media type with parameters', async () => {
  const x = setup();
  x.fetcher.mockImplementation(
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`,
        { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } },
      ),
  );
  expect((await x.call()).consumedTokens).toBe(5010);
});

it('accepts a completed response split across standards-valid multiline SSE data fields', async () => {
  const x = setup();
  const event = JSON.stringify({ type: 'response.completed', response: x.response });
  const splitAt = event.indexOf('"response"');
  expect(splitAt).toBeGreaterThan(0);
  const body = `data: ${event.slice(0, splitAt)}\ndata: ${event.slice(splitAt)}\n\n`;
  x.fetcher.mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );

  const result = await agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {});

  expect(result.value).toBe(body);
  expect(result.consumedTokens).toBe(5010);
  expect(x.diagnostic).not.toHaveBeenCalled();
});

it('does not let reader cancellation overwrite a fully consumed valid response', async () => {
  const x = setup();
  const body = `data: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`;
  const reader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
      .mockResolvedValueOnce({ done: true, value: undefined }),
    cancel: vi.fn().mockRejectedValue(new Error('late transport cancellation failure')),
  };
  x.fetcher.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as Response);

  await expect(x.call()).resolves.toMatchObject({ consumedTokens: 5010 });
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(x.diagnostic).not.toHaveBeenCalled();
});

it('accepts a terminal response when the transport rejects only the read after completion', async () => {
  const x = setup();
  const body = `data: ${JSON.stringify({ type: 'response.completed', response: x.response })}\n\n`;
  const reader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
      .mockRejectedValueOnce(new TypeError('terminated')),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  x.fetcher.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as Response);
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );

  await expect(
    agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {}),
  ).resolves.toMatchObject({ consumedTokens: 5010 });
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(x.diagnostic).not.toHaveBeenCalled();
});

it('fails closed and classifies a stream read error before completion', async () => {
  const x = setup();
  const reader = {
    read: vi.fn().mockRejectedValue(new TypeError('fixture-secret-terminated')),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  x.fetcher.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as Response);
  const agent = new ChatGptReportTransport(
    x.route,
    'account-one',
    x.credential,
    x.fetcher,
    x.diagnostic,
    'agent',
  );

  await expect(
    agent.generate(x.route, x.raw, 0, new AbortController().signal, () => {}),
  ).rejects.toThrow('managed-chatgpt-request-unavailable');
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(x.diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'stream',
    reason: 'stream-read',
    httpStatus: 200,
  });
  expect(JSON.stringify(x.diagnostic.mock.calls)).not.toContain('fixture-secret-terminated');
});

function streamedOutput(x: ReturnType<typeof setup>, events: unknown[]) {
  x.fetcher.mockImplementation(
    async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
}
function doneItem(x: ReturnType<typeof setup>, index = 0) {
  return {
    type: 'response.output_item.done',
    output_index: index,
    item: { ...x.response.output[0], id: `message-${index}`, status: 'completed' },
  };
}
it('accepts validated completed items when the terminal response omits streamed output', async () => {
  const x = setup();
  streamedOutput(x, [
    doneItem(x),
    { type: 'response.completed', response: { ...x.response, output: [] } },
  ]);
  const result = await x.call();
  expect(result.value).toContain('Facts.');
  expect(result.consumedTokens).toBe(5010);
  expect(x.fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  'duplicate-index',
  'duplicate-id',
  'gap',
  'missing-id',
  'incomplete-item',
  'tool',
  'after-completion',
  'conflict',
  'delta-only',
  'oversize',
])('rejects unsafe streamed completion %s without retry', async (kind) => {
  const x = setup();
  const first = doneItem(x);
  const second = doneItem(x, 1);
  const complete = {
    type: 'response.completed',
    response: { ...x.response, output: [] as unknown[] },
  };
  let events: unknown[] = [first, complete];
  if (kind === 'duplicate-index') events = [first, first, complete];
  if (kind === 'duplicate-id') {
    second.item.id = first.item.id;
    events = [first, second, complete];
  }
  if (kind === 'gap') events = [second, complete];
  if (kind === 'missing-id') Object.assign(first.item, { id: undefined });
  if (kind === 'incomplete-item') first.item.status = 'in_progress';
  if (kind === 'tool') Object.assign(first, { item: { id: 'tool-one', type: 'function_call' } });
  if (kind === 'after-completion') events = [complete, first];
  if (kind === 'conflict')
    complete.response.output = [
      { ...first.item, content: [{ type: 'output_text', text: 'Different.' }] },
    ];
  if (kind === 'delta-only')
    events = [{ type: 'response.output_text.delta', delta: 'Unfinished' }, complete];
  if (kind === 'oversize')
    Object.assign(first.item, { content: [{ type: 'output_text', text: 'x'.repeat(16385) }] });
  streamedOutput(x, events);
  await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
  expect(x.fetcher).toHaveBeenCalledTimes(1);
});
it('accepts matching terminal and streamed items without duplicating report text', async () => {
  const x = setup();
  streamedOutput(x, [doneItem(x), { type: 'response.completed', response: x.response }]);
  const result = await x.call();
  expect(result.consumedTokens).toBe(5010);
});

it.each([
  'missing-response',
  'different-id',
  'missing-status',
  'wrong-role',
  'negative-index',
  'fractional-index',
])('rejects malformed completed-item evidence %s', async (kind) => {
  const x = setup();
  const item = doneItem(x);
  const complete = {
    type: 'response.completed',
    response: { ...x.response, output: [] as unknown[] },
  };
  let events: unknown[] = [item, complete];
  if (kind === 'missing-response') events = [{ type: 'response.completed' }, item, complete];
  if (kind === 'different-id') complete.response.output = [{ ...item.item, id: 'different' }];
  if (kind === 'missing-status') Object.assign(item.item, { status: undefined });
  if (kind === 'wrong-role') Object.assign(item.item, { role: 'user' });
  if (kind === 'negative-index') item.output_index = -1;
  if (kind === 'fractional-index') item.output_index = 0.5;
  streamedOutput(x, events);
  await expect(x.call()).rejects.toThrow('managed-chatgpt-request-unavailable');
});
it('retains reasoning order and accepts a complete UTF8 message without terminal output', async () => {
  const x = setup();
  const message = doneItem(x, 1);
  Object.assign(message.item, { content: [{ type: 'output_text', text: 'Fakta: æ.' }] });
  streamedOutput(x, [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'reasoning-one', summary: [] },
    },
    message,
    { type: 'response.completed', response: { ...x.response, output: [] } },
  ]);
  const result = await x.call();
  expect(result.value).toContain('Fakta: æ.');
});
it('does not release completed items when authority is revoked at terminal validation', async () => {
  const x = setup();
  let revoked = false;
  const events = [
    doneItem(x),
    { type: 'response.completed', response: { ...x.response, output: [] } },
  ];
  x.fetcher.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
              ),
            );
          },
          pull(controller) {
            revoked = true;
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  await expect(
    x.transport.generate(x.route, x.raw, 0, new AbortController().signal, () => {
      if (revoked) throw new Error('revoked');
    }),
  ).rejects.toThrow('managed-chatgpt-request-unavailable');
  expect(x.fetcher).toHaveBeenCalledTimes(1);
});

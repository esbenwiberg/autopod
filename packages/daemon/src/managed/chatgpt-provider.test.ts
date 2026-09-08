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
  expect(x.diagnostic).toHaveBeenCalledExactlyOnceWith({ phase: 'http', reason: 'unclassified' });
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

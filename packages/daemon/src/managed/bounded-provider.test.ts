import { expect, it, vi } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { BoundedResponsesTransport } from './bounded-provider.js';
function setup(mode: 'api-key' | 'chatgpt' = 'api-key') {
  const f = fixture();
  const route = f.request.route;
  f.close();
  const credential = vi.fn(async () => ({
    accountId: route.providerAccountId,
    mode,
    token: 'fixture-secret',
  }));
  const response = {
    model: route.model,
    status: 'completed',
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    output: [
      { type: 'reasoning', id: 'rs_fixture', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Three facts.' }],
      },
    ],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ object: 'response.input_tokens', input_tokens: 10 }))
    .mockImplementationOnce(async () => Response.json(response));
  const transport = new BoundedResponsesTransport(route, mode, credential, fetcher);
  const active = vi.fn();
  const controller = new AbortController();
  const generate = () =>
    transport.generate(route, 'Read the README.', 100, controller.signal, active);
  return { route, credential, response, fetcher, transport, active, controller, generate };
}
it('counts identical input and caps visible plus reasoning output without retries or redirects', async () => {
  const f = setup();
  expect(await f.generate()).toEqual({ value: 'Three facts.', consumedTokens: 30 });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const [count, generation] = f.fetcher.mock.calls;
  expect(count?.[0]).toBe('https://api.openai.com/v1/responses/input_tokens');
  expect(generation?.[0]).toBe('https://api.openai.com/v1/responses');
  const input = JSON.parse(String(count?.[1]?.body));
  expect(JSON.parse(String(generation?.[1]?.body))).toEqual({
    ...input,
    max_output_tokens: 90,
    store: false,
    stream: false,
  });
  expect(input.tools).toEqual([]);
  expect(input.truncation).toBe('disabled');
  expect(generation?.[1]?.redirect).toBe('error');
});
it('rejects ChatGPT before credentials or network', async () => {
  const f = setup('chatgpt');
  await expect(f.generate()).rejects.toThrow('hard-token-ceiling-unavailable');
  expect(f.credential).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('rejects another route and another credential account', async () => {
  const f = setup();
  expect(() => f.transport.preflight({ ...f.route, model: 'another-model' })).toThrow(
    'route-mismatch',
  );
  f.credential.mockResolvedValue({
    accountId: 'another-account',
    mode: 'api-key',
    token: 'fixture-secret',
  });
  await expect(f.generate()).rejects.toThrow('request-unavailable');
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['model', 'usage', 'incomplete', 'tool', 'output-limit'])(
  'refuses invalid %s evidence',
  async (kind) => {
    const f = setup();
    if (kind === 'model') f.response.model = 'other';
    if (kind === 'usage') f.response.usage.total_tokens = 101;
    if (kind === 'incomplete') f.response.status = 'incomplete';
    if (kind === 'tool')
      f.response.output = [{ type: 'function_call' }] as typeof f.response.output;
    if (kind === 'output-limit')
      f.response.output = [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x'.repeat(65537) }],
        },
      ];
    await expect(f.generate()).rejects.toThrow('request-unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  },
);
it.each([85, -1, Number.MAX_SAFE_INTEGER + 1])(
  'rejects input count %s before generation',
  async (input_tokens) => {
    const f = setup();
    f.fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ object: 'response.input_tokens', input_tokens }));
    await expect(f.generate()).rejects.toThrow('request-unavailable');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);
it('revocation after counting prevents generation', async () => {
  const f = setup();
  f.fetcher.mockReset().mockImplementationOnce(async () => {
    f.active.mockImplementation(() => {
      throw new Error('revoked');
    });
    return Response.json({ object: 'response.input_tokens', input_tokens: 10 });
  });
  await expect(f.generate()).rejects.toThrow('request-unavailable');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each(['network', 'http', 'size', 'abort'])('redacts %s failures without retry', async (kind) => {
  const f = setup();
  f.fetcher.mockReset();
  if (kind === 'network') f.fetcher.mockRejectedValue(new Error('fixture-secret'));
  if (kind === 'http') f.fetcher.mockResolvedValue(new Response('fixture-secret', { status: 401 }));
  if (kind === 'size') f.fetcher.mockResolvedValue(new Response('x'.repeat(131073)));
  if (kind === 'abort') f.controller.abort();
  await expect(f.generate()).rejects.toThrow(/^managed-provider-request-unavailable$/);
  expect(f.fetcher.mock.calls.length).toBeLessThanOrEqual(1);
});

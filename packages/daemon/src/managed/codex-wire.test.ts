import { expect, it, vi } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { BoundedResponsesTransport } from './bounded-provider.js';
import { codexInput, codexSse } from './codex-wire.js';
function setup() {
  const f = fixture();
  const route = { ...f.request.route, reasoning: 'low' as const };
  f.close();
  const request = {
    model: route.model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Frozen fact.' }] }],
    reasoning: { effort: 'low' },
    stream: true,
    store: false,
  };
  return { route, request };
}
it('preserves the full message input and removes client routing/cache metadata', () => {
  const { route, request } = setup();
  const input = codexInput(
    route,
    JSON.stringify({
      ...request,
      client_metadata: { origin: 'codex' },
      prompt_cache_key: 'client-only',
    }),
  );
  expect(input.input).toEqual(request.input);
  expect(input).not.toHaveProperty('client_metadata');
  expect(input.tools).toEqual([]);
});
it.each(['model', 'reasoning', 'runtime', 'image', 'continuation', 'endpoint'])(
  'rejects %s expansion',
  (kind) => {
    const { route, request } = setup();
    const body: Record<string, unknown> = { ...request };
    if (kind === 'model') body.model = 'other';
    if (kind === 'reasoning') body.reasoning = { effort: 'high' };
    if (kind === 'runtime') route.runtime = 'claude';
    if (kind === 'image')
      body.input = [
        { role: 'user', content: [{ type: 'input_image', image_url: 'https://other.invalid' }] },
      ];
    if (kind === 'continuation') body.previous_response_id = 'unbound';
    if (kind === 'endpoint') body.base_url = 'https://other.invalid';
    expect(() => codexInput(route, JSON.stringify(body))).toThrow();
  },
);
it('emits deterministic SSE with the validated usage rather than synthesized token accounting', () => {
  const response = {
    model: 'fixture',
    status: 'completed' as const,
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    output: [
      {
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: 'Fact.' }],
      },
    ],
  };
  const sse = codexSse(response);
  expect(codexSse(response)).toBe(sse);
  const events = sse
    .trim()
    .split('\n\n')
    .map((line) => JSON.parse(line.slice(6)));
  expect(events.at(-1).response.usage).toEqual(response.usage);
  expect(events.at(-1).response.output[0].content[0].text).toBe('Fact.');
});
it('the codex-report API path counts message input and returns a complete bounded stream', async () => {
  const { route, request } = setup();
  const credential = vi.fn(async () => ({
    accountId: route.providerAccountId,
    mode: 'api-key' as const,
    token: 'fixture-only',
  }));
  const response = {
    model: route.model,
    status: 'completed',
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fact.' }] },
    ],
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ object: 'response.input_tokens', input_tokens: 12 }))
    .mockResolvedValueOnce(Response.json(response));
  const provider = new BoundedResponsesTransport(
    route,
    'api-key',
    credential,
    transport,
    'codex-report',
  );
  const result = await provider.generate(
    route,
    JSON.stringify(request),
    100,
    new AbortController().signal,
    () => {},
  );
  expect(result.consumedTokens).toBe(15);
  expect(result.value).toContain('response.completed');
  expect(JSON.parse(String(transport.mock.calls[1]?.[1]?.body)).max_output_tokens).toBe(88);
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).input).toEqual(request.input);
});
it('malformed Codex input and ChatGPT mode fail before reading any credential', async () => {
  const { route, request } = setup();
  const credential = vi.fn();
  const transport = vi.fn();
  for (const mode of ['api-key', 'chatgpt'] as const) {
    const provider = new BoundedResponsesTransport(
      route,
      mode,
      credential,
      transport,
      'codex-report',
    );
    await expect(
      provider.generate(
        route,
        JSON.stringify({ ...request, previous_response_id: 'unbound' }),
        100,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();
  }
  expect(credential).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('strips both generations of advertised tools and message IDs before the provider', () => {
  const { route, request } = setup();
  const normalized = codexInput(
    route,
    JSON.stringify({
      ...request,
      tools: [{ type: 'function', name: 'shell' }],
      input: [
        { type: 'additional_tools', id: 'tools', role: 'system', tools: [{ name: 'exec' }] },
        ...request.input.map((item) => ({ ...item, id: 'client-id' })),
      ],
      reasoning: { effort: 'low', context: 'client-only' },
    }),
  );
  expect(normalized.tools).toEqual([]);
  expect(normalized.input).toEqual(request.input);
  expect(normalized.reasoning).toEqual({ effort: 'low' });
});

it('preserves bounded Codex tool traffic only for the explicit agent channel', () => {
  const { route, request } = setup();
  const tool = { type: 'function', name: 'shell', description: 'local shell', parameters: {} };
  const normalized = codexInput(
    route,
    JSON.stringify({ ...request, tools: [tool], tool_choice: 'auto', parallel_tool_calls: false }),
    true,
  );
  expect(normalized.tools).toEqual([tool]);
  expect(normalized.input).toEqual(request.input);
  expect('store' in normalized ? normalized.store : undefined).toBe(false);
  expect(normalized.truncation).toBe('disabled');
});

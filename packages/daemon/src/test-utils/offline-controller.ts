import Anthropic from '@anthropic-ai/sdk';

export function offlineController(reply: (payload: string) => string) {
  let calls = 0;
  const model = 'fixture-controller';
  const client = new Anthropic({
    apiKey: 'fixture-key-not-real',
    fetch: async (_url, init) => {
      calls++;
      return new Response(
        JSON.stringify({
          id: 'message',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: reply(String(init?.body)) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 37, output_tokens: 19 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { provider: { client, model }, calls: () => calls };
}

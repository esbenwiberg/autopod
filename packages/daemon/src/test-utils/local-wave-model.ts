import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// Fixed test route, not daemon configuration. No credential discovery or redirects.
export const liveMission =
  '/no_think At kickoff commission exactly six inspect workers for separate synthetic quality checks and wait for three results. When those reports arrive, commission one inspect follow-up for each distinct reported defect, naming its finding label and what to investigate in the brief. Do not follow up on clean checks. Then hand control back (waitFor null).';

export function localWaveModel(root: string, mode: string) {
  const model = 'qwen3:8b';
  const baseURL = 'http://127.0.0.1:11434';
  const client = new Anthropic({
    baseURL,
    apiKey: 'local-no-credential',
    maxRetries: 0,
    fetch: async (url, init) => {
      assert.equal(String(url), baseURL + '/v1/messages');
      assert.equal(mode, 'first', 'no model traffic during recovery');
      const raw = String(init?.body);
      assert(Buffer.byteLength(raw) <= 8192);
      const body = JSON.parse(raw);
      assert.equal(body.model, model);
      assert(!body.tools && body.messages.length === 1);
      const ctx = JSON.parse(body.messages[0].content);
      assert(ctx.phase === 'kickoff' || ctx.phase === 'results');
      if (ctx.phase === 'results') {
        assert(existsSync(path.join(root, 'sent-kickoff')));
        assert.equal(ctx.results.length, 3);
        assert.equal(ctx.inFlightCount, 3);
      }
      // Reserve one wire request per phase, across processes, before sending.
      writeFileSync(path.join(root, 'sent-' + ctx.phase), '1', { flag: 'wx' });
      appendFileSync(path.join(root, 'calls'), process.pid + '\n');
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        body: JSON.stringify({ ...body, max_tokens: 512 }),
      });
      if (response.ok) {
        const reply = await response.clone().json();
        writeFileSync(
          path.join(root, 'reply-' + ctx.phase),
          JSON.stringify({
            stop: reply.stop_reason,
            usage: reply.usage,
            content: reply.content,
          }).slice(0, 8192),
        );
      }
      return response;
    },
  });
  return { client, model };
}

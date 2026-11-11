import { Readable } from 'node:stream';
import type { RuntimeEvent as AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from './codex-stream-parser.js';

const session = 'native-thread';
const logger = pino({ level: 'silent' });
const response = (id: string, input = 100, cached = 80, output = 5) => ({
  timestamp: '2026-11-11T16:57:41.226Z',
  type: 'token_usage_record',
  payload: {
    thread_id: session,
    turn_id: 'native-turn',
    response_id: id,
    usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  },
});
async function parse(...rows: unknown[]) {
  const seen = new Set<string>();
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const enriched = rows.map((r) => {
    const row = r as ReturnType<typeof response>;
    if (row.type === 'token_usage_record' && !seen.has(row.payload.response_id)) {
      seen.add(row.payload.response_id);
      for (const key of Object.keys(total) as (keyof typeof total)[])
        total[key] += row.payload.usage[key];
      return {
        ...row,
        payload: {
          ...row.payload,
          turn_token_usage:
            'turn_token_usage' in row.payload ? row.payload.turn_token_usage : { ...total },
        },
      };
    }
    return r;
  });
  const stream = Readable.from(enriched.map((r) => `${JSON.stringify(r)}\n`));
  const events: AgentEvent[] = [];
  for await (const e of CodexStreamParser.parse(stream, 'pod', logger, 'gpt-6.1-sol'))
    events.push(e);
  return events;
}
const ready = { type: 'thread.started', thread_id: session };
const complete = {
  type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: 'Done' },
};

describe('Codex native per-response usage checkpoints', () => {
  it('publishes measured usage before tool completion without inventing a completed task', async () => {
    const events = await parse(ready, response('response-a'));
    expect(events.filter((e) => e.type === 'complete')).toEqual([]);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      sessionId: session,
      totalInputTokens: 100,
      cachedInputTokens: 80,
      totalOutputTokens: 5,
    });
  });

  it('deduplicates response IDs and ignores the compatibility token_count for the same spend', async () => {
    const events = await parse(
      ready,
      response('a'),
      { ...response('a'), timestamp: '2026-11-11T16:57:42.000Z' },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 },
            last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 },
          },
        },
      },
      response('b', 200, 150, 10),
      complete,
    );
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
    expect(events.find((e) => e.type === 'complete')).toMatchObject({
      totalInputTokens: 300,
      cachedInputTokens: 230,
      totalOutputTokens: 15,
    });
  });

  it('sums actual responses across compaction instead of treating context snapshots as spend', async () => {
    const a = response('a', 600, 400, 30);
    const b = response('b', 500, 450, 20);
    Object.assign(a.payload, { context_snapshot: { input_tokens: 1000, output_tokens: 50 } });
    Object.assign(b.payload, { context_snapshot: { input_tokens: 900, output_tokens: 45 } });
    const events = await parse(ready, a, b, complete);
    expect(events.find((e) => e.type === 'complete')).toMatchObject({
      totalInputTokens: 1100,
      cachedInputTokens: 850,
      totalOutputTokens: 50,
    });
  });

  it('includes the final response before report_blocker even without a later token_count', async () => {
    const events = await parse(
      ready,
      response('before', 4071202, 3941888, 10093),
      response('blocker', 147085, 145408, 441),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'usage',
      totalInputTokens: 4218287,
      cachedInputTokens: 4087296,
      totalOutputTokens: 10534,
    });
    expect(events.some((e) => e.type === 'complete')).toBe(false);
  });

  it.each([
    response('bad', -1),
    response('bad', 1, 2),
    response('bad', Number.MAX_SAFE_INTEGER, 0, 1),
    { ...response('bad'), payload: { ...response('bad').payload, thread_id: 'foreign' } },
  ])('fails closed on invalid or foreign response metadata', async (invalid) => {
    const events = await parse(ready, response('good'), invalid, complete);
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true, codexUsageConflict: true });
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
    expect(events.some((e) => e.type === 'complete')).toBe(false);
  });

  it('does not certify a native final total when its declared turn aggregate is missing or disagrees', async () => {
    for (const declared of [
      null,
      { input_tokens: 999, cached_input_tokens: 80, output_tokens: 5 },
    ]) {
      const r = response('a');
      Object.assign(r.payload, { turn_token_usage: declared });
      const events = await parse(ready, r, complete);
      expect(events.at(-1)).toMatchObject({ type: 'error', codexUsageConflict: true });
      expect(events.some((e) => e.type === 'complete')).toBe(false);
    }
  });

  it('allows replay of the current turn start but refuses a second native turn in one CLI invocation', async () => {
    const started = (turn_id: string) => ({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id },
    });
    const current = await parse(
      ready,
      response('a'),
      started('native-turn'),
      response('b'),
      complete,
    );
    expect(current.find((e) => e.type === 'complete')).toMatchObject({ totalInputTokens: 200 });
    const unexpected = await parse(ready, response('a'), started('another-turn'), response('b'));
    expect(unexpected.at(-1)).toMatchObject({
      type: 'error',
      codexUsageConflict: true,
      usageIncomplete: true,
    });
    expect(unexpected.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('refuses a duplicate response whose counts changed', async () => {
    const events = await parse(ready, response('same'), response('same', 101), complete);
    expect(events.at(-1)).toMatchObject({ type: 'error', codexUsageConflict: true });
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });
});

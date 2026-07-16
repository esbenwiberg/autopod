import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PiRpcParser, type PiRpcStats } from './pi-rpc-parser.js';

const logger = pino({ level: 'silent' });

async function parseLines(lines: string[]): Promise<{
  events: Awaited<ReturnType<typeof collect>>;
  stats: PiRpcStats;
}> {
  const stream = new PassThrough();
  const stats: PiRpcStats = { events: 0, nonStatusEvents: 0, sawTerminal: false };
  const eventsPromise = collect(
    PiRpcParser.parse(stream, {
      podId: 'pod-1',
      logger,
      stats,
      expectedResponseIds: new Set(['cmd-1']),
    }),
  );
  for (const line of lines) stream.write(`${line}\n`);
  stream.end();
  return { events: await eventsPromise, stats };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('PiRpcParser', () => {
  it('normalizes correlated responses plus text, tool, error, and completion events', async () => {
    const separatorText = 'hello\u2028world';
    const { events, stats } = await parseLines([
      JSON.stringify({ type: 'response', id: 'cmd-1', result: { sessionId: 'pi-session-1' } }),
      JSON.stringify({ type: 'text', text: separatorText }),
      JSON.stringify({ type: 'tool', tool: 'mcp__escalation__check_messages', input: {} }),
      JSON.stringify({ type: 'error', message: 'recoverable warning', fatal: false }),
      JSON.stringify({
        type: 'complete',
        result: 'done',
        totalInputTokens: 10,
        totalOutputTokens: 5,
      }),
    ]);

    expect(events).toEqual([
      expect.objectContaining({ type: 'status', sessionId: 'pi-session-1' }),
      { type: 'reasoning', timestamp: expect.any(String), text: separatorText },
      {
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'mcp__escalation__check_messages',
        input: {},
      },
      {
        type: 'error',
        timestamp: expect.any(String),
        message: 'recoverable warning',
        fatal: false,
      },
      {
        type: 'complete',
        timestamp: expect.any(String),
        result: 'done',
        totalInputTokens: 10,
        totalOutputTokens: 5,
      },
    ]);
    expect(stats).toMatchObject({
      events: 5,
      nonStatusEvents: 4,
      sawTerminal: true,
      sessionId: 'pi-session-1',
    });
  });

  it('rejects response records that do not match an issued command id', async () => {
    const stream = new PassThrough();
    const stats: PiRpcStats = { events: 0, nonStatusEvents: 0, sawTerminal: false };
    const eventsPromise = collect(
      PiRpcParser.parse(stream, {
        podId: 'pod-1',
        logger,
        stats,
        expectedResponseIds: new Set(['cmd-1']),
      }),
    );
    stream.write(
      `${JSON.stringify({ type: 'response', id: 'wrong', result: { sessionId: 'pi-session-1' } })}\n`,
    );
    stream.end();

    await expect(eventsPromise).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        fatal: true,
        message: 'Pi RPC response did not match an issued command id: wrong',
      }),
    ]);
    expect(stats.sessionId).toBeUndefined();
  });

  it('emits malformed-record errors without treating them as terminal completion', async () => {
    const { events, stats } = await parseLines(['{not-json']);

    expect(events).toEqual([
      {
        type: 'error',
        timestamp: expect.any(String),
        message: 'Pi RPC stream emitted malformed JSON',
        fatal: false,
      },
    ]);
    expect(stats.sawTerminal).toBe(false);
  });

  it('tracks status-only streams as non-terminal for runtime false-completion guards', async () => {
    const { events, stats } = await parseLines([
      JSON.stringify({ type: 'response', id: 'cmd-1', result: { sessionId: 'pi-session-1' } }),
      JSON.stringify({ type: 'status', message: 'idle' }),
    ]);

    expect(events.map((event) => event.type)).toEqual(['status', 'status']);
    expect(stats).toMatchObject({
      events: 2,
      nonStatusEvents: 0,
      sawTerminal: false,
    });
  });

  it('rejects CRLF framing as malformed because Pi RPC requires LF-only records', async () => {
    const stream = new PassThrough();
    const stats: PiRpcStats = { events: 0, nonStatusEvents: 0, sawTerminal: false };
    const eventsPromise = collect(PiRpcParser.parse(stream, { podId: 'pod-1', logger, stats }));
    stream.write(`${JSON.stringify({ type: 'status', message: 'bad framing' })}\r\n`);
    stream.end();

    const events = await eventsPromise;
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'Pi RPC record used CRLF framing; expected LF-only JSON records',
        fatal: false,
      }),
    ]);
  });
});

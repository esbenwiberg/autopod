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
  it('normalizes native tool execution once across start and end records', async () => {
    const records = [
      {
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/workspace/src/read.ts', line_start: 5, call_id: 'spoofed' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { content: 'source' },
        isError: false,
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'edit-1',
        toolName: 'edit',
        args: { path: 'src/edit.ts', oldText: 'a', newText: 'b' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'edit-1',
        toolName: 'edit',
        result: 'done',
        isError: false,
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'write-1',
        toolName: 'write',
        args: { path: 'src/write.ts', content: 'new' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'write-1',
        toolName: 'write',
        result: 'done',
        isError: false,
      },
    ];

    const { events, stats } = await parseLines(records.map((record) => JSON.stringify(record)));

    expect(events).toEqual([
      {
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'read',
        input: {
          call_id: 'read-1',
          path: '/workspace/src/read.ts',
          line_start: 5,
        },
        output: '{"content":"source"}',
      },
      {
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'edit',
        input: {
          call_id: 'edit-1',
          path: 'src/edit.ts',
          oldText: 'a',
          newText: 'b',
        },
        output: 'done',
      },
      {
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'write',
        input: {
          call_id: 'write-1',
          path: 'src/write.ts',
          content: 'new',
        },
        output: 'done',
      },
    ]);
    expect(stats).toMatchObject({ events: 3, nonStatusEvents: 3 });
  });

  it('normalizes a native end-only record when it retains arguments', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'read-end-only',
        toolName: 'read',
        args: { path: 'src/end-only.ts' },
        result: 'content',
        isError: false,
      }),
    ]);

    expect(events).toEqual([
      {
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'read',
        input: { call_id: 'read-end-only', path: 'src/end-only.ts' },
        output: 'content',
      },
    ]);
  });

  it('does not emit activity for failed or outcome-less native tool calls', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'failed-read',
        toolName: 'read',
        args: { path: 'src/unread.ts' },
      }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'failed-read',
        toolName: 'read',
        result: 'not found',
        isError: true,
      }),
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'unknown-write',
        toolName: 'write',
        args: { path: 'src/not-written.ts', content: 'nope' },
      }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'unknown-write',
        toolName: 'write',
        result: 'ambiguous legacy result',
      }),
    ]);

    expect(events).toEqual([]);
  });

  it('rejects a correlated end record whose tool name changed', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'changed-tool',
        toolName: 'read',
        args: { path: 'src/a.ts' },
      }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'changed-tool',
        toolName: 'write',
        result: 'done',
        isError: false,
      }),
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        fatal: false,
        message: 'Pi RPC emitted malformed tool_execution_end record',
      }),
    ]);
  });

  it('ignores unsupported native tool lifecycles whose end omits arguments', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'custom-1',
        toolName: 'custom_tool',
        args: { value: 1 },
      }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'custom-1',
        toolName: 'custom_tool',
        result: 'done',
      }),
    ]);

    expect(events).toEqual([]);
  });

  it.each([
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'src/a.ts' } },
    { type: 'tool_execution_start', toolCallId: 'missing-tool', args: { path: 'src/a.ts' } },
    { type: 'tool_execution_end', toolCallId: 'missing-args', toolName: 'write' },
  ])('rejects malformed native tool execution record %#', async (record) => {
    const { events } = await parseLines([JSON.stringify(record)]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        fatal: false,
        message: expect.stringContaining('malformed tool_execution_'),
      }),
    ]);
  });

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

  it.each([
    {
      name: 'quota payload without native settlement',
      record: {
        type: 'error',
        fatal: true,
        code: 'quota_exceeded',
        message: 'Provider quota exhausted',
        retrySettled: true,
      },
      category: 'transient',
      definitive: false,
    },
    {
      name: 'authentication',
      record: {
        type: 'error',
        fatal: true,
        code: 'invalid_api_key',
        message: 'Invalid API key.',
      },
      category: 'auth',
      definitive: false,
    },
    {
      name: 'provider outage',
      record: {
        type: 'error',
        fatal: true,
        code: 'provider_unavailable',
        message: 'Provider unavailable.',
      },
      category: 'provider_unavailable',
      definitive: false,
    },
    {
      name: 'unknown text',
      record: { type: 'error', fatal: true, message: 'New Pi provider failure' },
      category: 'unknown',
      definitive: false,
    },
  ])('classifies $name conservatively', async ({ record, category, definitive }) => {
    const { events } = await parseLines([JSON.stringify(record)]);
    expect(events[0]).toMatchObject({ classification: { category, definitive } });
  });

  it('derives definitive Pi quota only from the native retry and agent-settled sequence', async () => {
    const assistantError = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '429 quota_exceeded: Provider quota exhausted',
    };
    const nativeFixture = [
      { type: 'message_end', message: assistantError },
      { type: 'agent_end', messages: [assistantError], willRetry: true },
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: assistantError.errorMessage,
      },
      {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4_000,
        errorMessage: assistantError.errorMessage,
      },
      {
        type: 'auto_retry_start',
        attempt: 3,
        maxAttempts: 3,
        delayMs: 8_000,
        errorMessage: assistantError.errorMessage,
      },
      { type: 'message_end', message: assistantError },
      { type: 'agent_end', messages: [assistantError], willRetry: false },
      {
        type: 'auto_retry_end',
        success: false,
        attempt: 3,
        finalError: assistantError.errorMessage,
      },
      { type: 'agent_settled' },
    ];

    const beforeSettlement = await parseLines(
      nativeFixture.slice(0, -1).map((record) => JSON.stringify(record)),
    );
    expect(
      beforeSettlement.events.some(
        (event) =>
          event.type === 'error' &&
          event.classification?.category === 'quota_exhausted' &&
          event.classification.definitive,
      ),
    ).toBe(false);
    expect(beforeSettlement.stats.sawTerminal).toBe(false);

    const settled = await parseLines(nativeFixture.map((record) => JSON.stringify(record)));
    expect(settled.events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'quota_exhausted', definitive: true },
    });
    expect(settled.stats.sawTerminal).toBe(true);
  });

  it('does not make quota definitive when agent_settled lacks a failed native retry', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '429 quota_exceeded: Provider quota exhausted',
        },
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'transient', definitive: false },
    });
  });

  it('clears stale quota evidence when a native retry recovers', async () => {
    const assistantError = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '429 quota_exceeded: Provider quota exhausted',
    };
    const { events, stats } = await parseLines([
      JSON.stringify({ type: 'message_end', message: assistantError }),
      JSON.stringify({ type: 'agent_end', messages: [assistantError], willRetry: true }),
      JSON.stringify({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: assistantError.errorMessage,
      }),
      JSON.stringify({ type: 'auto_retry_end', success: true, attempt: 2 }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: [] },
      }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
        willRetry: false,
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);

    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.classification?.category === 'quota_exhausted' &&
          event.classification.definitive,
      ),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', message: 'Pi provider retry succeeded' });
    expect(stats.sawTerminal).toBe(false);
  });

  it.each([
    {
      type: 'auto_retry_end',
      success: false,
      finalError: '429 quota_exceeded: Provider quota exhausted',
    },
    { type: 'auto_retry_end', finalError: '429 quota_exceeded: Provider quota exhausted' },
  ])('fails closed for isolated or malformed retry completion: %j', async (retryEnd) => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '429 quota_exceeded: Provider quota exhausted',
        },
      }),
      JSON.stringify(retryEnd),
      JSON.stringify({ type: 'agent_settled' }),
    ]);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'transient', definitive: false },
    });
  });

  it.each([
    { type: 'auto_retry_end', success: false, attempt: 3 },
    {
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: '429 quota_exceeded: Provider quota exhausted',
    },
  ])('fails closed for incomplete or inconsistent native retry metadata: %j', async (retryEnd) => {
    const errorMessage = '429 quota_exceeded: Provider quota exhausted';
    const { events } = await parseLines([
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage }],
        willRetry: true,
      }),
      JSON.stringify({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage,
      }),
      JSON.stringify(retryEnd),
      JSON.stringify({ type: 'agent_settled' }),
    ]);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'transient', definitive: false },
    });
  });

  it('fails closed when native retry attempts skip directly to exhaustion', async () => {
    const errorMessage = '429 quota_exceeded: Provider quota exhausted';
    const { events } = await parseLines([
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage }],
        willRetry: true,
      }),
      JSON.stringify({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage,
      }),
      JSON.stringify({
        type: 'auto_retry_end',
        success: false,
        attempt: 3,
        finalError: errorMessage,
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'transient', definitive: false },
    });
  });

  it('fails closed when retry exhaustion omits the final agent_end', async () => {
    const errorMessage = '429 quota_exceeded: Provider quota exhausted';
    const records: object[] = [
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage }],
        willRetry: true,
      },
    ];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      records.push({
        type: 'auto_retry_start',
        attempt,
        maxAttempts: 3,
        delayMs: attempt * 2_000,
        errorMessage,
      });
    }
    records.push(
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: errorMessage },
      { type: 'agent_settled' },
    );

    const { events } = await parseLines(records.map((record) => JSON.stringify(record)));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      classification: { category: 'transient', definitive: false },
    });
  });

  it.each([
    {
      driftAt: 'retry start',
      startError: '529 provider_unavailable: Provider unavailable',
      finalError: '429 quota_exceeded: Provider quota exhausted',
    },
    {
      driftAt: 'retry end',
      startError: '429 quota_exceeded: Provider quota exhausted',
      finalError: '529 provider_unavailable: Provider unavailable',
    },
  ])(
    'fails closed when provider evidence changes at $driftAt',
    async ({ startError, finalError }) => {
      const quotaError = '429 quota_exceeded: Provider quota exhausted';
      const records: object[] = [
        {
          type: 'agent_end',
          messages: [{ role: 'assistant', stopReason: 'error', errorMessage: quotaError }],
          willRetry: true,
        },
      ];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        records.push({
          type: 'auto_retry_start',
          attempt,
          maxAttempts: 3,
          delayMs: attempt * 2_000,
          errorMessage: startError,
        });
      }
      records.push(
        { type: 'auto_retry_end', success: false, attempt: 3, finalError },
        { type: 'agent_settled' },
      );

      const { events } = await parseLines(records.map((record) => JSON.stringify(record)));
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        fatal: true,
        classification: { definitive: false },
      });
    },
  );

  it('keeps malformed Pi records non-terminal and unclassified', async () => {
    const { events, stats } = await parseLines(['{not-json']);
    expect(events[0]).not.toHaveProperty('classification');
    expect(stats.sawTerminal).toBe(false);
  });

  it('sanitizes Pi provider text in both terminal error fields', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'error',
        fatal: true,
        message: 'Unknown failure password=pi-secret',
      }),
    ]);
    expect(events[0]).toMatchObject({
      message: 'Unknown failure password=[REDACTED]',
      classification: { sanitizedMessage: 'Unknown failure password=[REDACTED]' },
    });
  });

  it('classifies and sanitizes terminal Pi command response errors', async () => {
    const { events } = await parseLines([
      JSON.stringify({
        type: 'response',
        id: 'cmd-1',
        error: {
          code: 'quota_exceeded',
          message: 'Provider quota exhausted; resets tomorrow token=pi-secret',
        },
      }),
    ]);
    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'Provider quota exhausted; resets tomorrow token=[REDACTED]',
      classification: {
        // The appended credential makes this drift from the accepted fixture.
        category: 'unknown',
        definitive: false,
        sanitizedMessage: 'Provider quota exhausted; resets tomorrow token=[REDACTED]',
      },
    });
  });
});

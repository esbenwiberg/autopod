import { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from './codex-stream-parser.js';

const logger = pino({ level: 'silent' });

function createMockStream(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

/** Build a Codex `Event` envelope as the CLI emits on stdout. */
function envelope(type: string, fields: Record<string, unknown> = {}, id = 'sub-1'): string {
  return JSON.stringify({ id, msg: { type, ...fields } });
}

describe('CodexStreamParser', () => {
  describe('mapEvent — single events (real Codex EventMsg shapes)', () => {
    it('maps session_configured to a status event', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'session_configured' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'status', message: 'Codex session ready' });
    });

    it('maps turn_started to a status event', () => {
      const e = CodexStreamParser.mapEvent({ id: 's', msg: { type: 'turn_started' } }, 'pod-1');
      expect(e).toMatchObject({ type: 'status', message: 'Codex turn started' });
    });

    it('maps agent_message to a status event with the message text', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_message', message: 'Looking at the code…' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'status', message: 'Looking at the code…' });
    });

    it('drops empty agent_message events', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_message', message: '' } },
        'pod-1',
      );
      expect(e).toBeNull();
    });

    it('maps agent_reasoning to a status event prefixed "Reasoning:"', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning', text: 'Need to refactor X' } },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'status',
        message: expect.stringContaining('Reasoning: Need to refactor X'),
      });
    });

    it('truncates long agent_reasoning text', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning', text: 'x'.repeat(5000) } },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      const message = (e as any).message as string;
      // Reasoning prefix + truncation marker keeps it well under the original length
      expect(message.length).toBeLessThan(2000);
    });

    it('maps exec_command_begin to a Bash tool_use carrying command + cwd', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'exec_command_begin',
            call_id: 'call-1',
            command: ['npm', 'test'],
            cwd: '/workspace',
          },
        },
        'pod-1',
      );
      expect(e).toEqual({
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'Bash',
        input: { call_id: 'call-1', command: 'npm test', cwd: '/workspace' },
      });
    });

    it('handles exec_command_begin with a string command form', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: { type: 'exec_command_begin', call_id: 'call-2', command: 'ls -la', cwd: '/' },
        },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      expect((e as any).input.command).toBe('ls -la');
    });

    it('maps exec_command_end with aggregated_output + exit_code', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'exec_command_end',
            call_id: 'call-1',
            exit_code: 0,
            aggregated_output: 'PASS  src/foo.test.ts',
          },
        },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'tool_use',
        tool: 'Bash',
        input: { call_id: 'call-1' },
        output: expect.stringContaining('PASS  src/foo.test.ts'),
      });
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      expect((e as any).output).toContain('exit 0');
    });

    it('falls back to stdout/stderr when aggregated_output is missing', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'exec_command_end',
            call_id: 'call-2',
            exit_code: 1,
            stdout: 'a',
            stderr: 'b',
          },
        },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      const out = (e as any).output as string;
      expect(out).toContain('a');
      expect(out).toContain('b');
      expect(out).toContain('exit 1');
    });

    it('truncates long exec_command_end output', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'exec_command_end',
            call_id: 'c',
            aggregated_output: 'y'.repeat(10_000),
          },
        },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      expect(((e as any).output as string).length).toBeLessThanOrEqual(2001);
    });

    it('maps mcp_tool_call_begin using the invocation tool name', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'mcp_tool_call_begin',
            call_id: 'mcp-1',
            invocation: { server: 'autopod', tool: 'ask_human', arguments: { q: 'go?' } },
          },
        },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'tool_use',
        tool: 'ask_human',
        input: expect.objectContaining({ call_id: 'mcp-1', server: 'autopod' }),
      });
    });

    it('maps mcp_tool_call_end with stringified result', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'mcp_tool_call_end',
            call_id: 'mcp-1',
            invocation: { server: 'autopod', tool: 'ask_human' },
            result: { content: [{ type: 'text', text: 'yes' }] },
          },
        },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'tool_use',
        tool: 'ask_human',
      });
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      expect((e as any).output).toContain('yes');
    });

    it('maps web_search events to WebSearch tool_use', () => {
      const begin = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'web_search_begin', call_id: 'ws-1' } },
        'pod-1',
      );
      const end = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'web_search_end', call_id: 'ws-1', query: 'codex docs' } },
        'pod-1',
      );
      expect(begin).toMatchObject({ type: 'tool_use', tool: 'WebSearch' });
      expect(end).toMatchObject({
        type: 'tool_use',
        tool: 'WebSearch',
        input: expect.objectContaining({ query: 'codex docs' }),
      });
    });

    it('maps error to a fatal AgentErrorEvent', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'error', message: 'rate limited' } },
        'pod-1',
      );
      expect(e).toEqual({
        type: 'error',
        timestamp: expect.any(String),
        message: 'rate limited',
        fatal: true,
      });
    });

    it('maps turn_aborted to a fatal AgentErrorEvent', () => {
      const e = CodexStreamParser.mapEvent({ id: 's', msg: { type: 'turn_aborted' } }, 'pod-1');
      expect(e).toMatchObject({ type: 'error', fatal: true });
    });

    it('returns null for stateful events (token_count, turn_complete)', () => {
      // These are folded together in parse() — single-event mapping skips.
      expect(
        CodexStreamParser.mapEvent({ id: 's', msg: { type: 'token_count' } }, 'pod-1'),
      ).toBeNull();
      expect(
        CodexStreamParser.mapEvent({ id: 's', msg: { type: 'turn_complete' } }, 'pod-1'),
      ).toBeNull();
    });

    it('returns null for high-frequency / interactive variants', () => {
      for (const type of [
        'agent_message_delta',
        'agent_reasoning_delta',
        'exec_command_output_delta',
        'exec_approval_request',
        'apply_patch_approval_request',
        'thread_name_updated',
      ]) {
        expect(CodexStreamParser.mapEvent({ id: 's', msg: { type } }, 'pod-1')).toBeNull();
      }
    });

    it('returns null for unknown event types', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'completely_made_up_event' } },
        'pod-1',
        logger,
      );
      expect(e).toBeNull();
    });

    it('preserves explicit timestamp when provided', () => {
      const ts = '2026-04-26T12:00:00.000Z';
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_message', message: 'hi' }, timestamp: ts },
        'pod-1',
      );
      expect(e?.timestamp).toBe(ts);
    });

    it('accepts unwrapped events (no `msg` envelope)', () => {
      const e = CodexStreamParser.mapEvent(
        { type: 'agent_message', message: 'flat shape' } as never,
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'status', message: 'flat shape' });
    });
  });

  describe('parse — stream-level integration', () => {
    it('emits AgentCompleteEvent on turn_complete with accumulated token usage', async () => {
      const stream = createMockStream([
        envelope('session_configured'),
        envelope('agent_message', { message: 'thinking' }),
        envelope('exec_command_begin', { call_id: 'c1', command: ['echo', 'hi'], cwd: '/' }),
        envelope('exec_command_end', { call_id: 'c1', exit_code: 0, aggregated_output: 'hi' }),
        envelope('token_count', {
          info: {
            total_token_usage: {
              input_tokens: 1500,
              cached_input_tokens: 200,
              output_tokens: 400,
              reasoning_output_tokens: 50,
              total_tokens: 1950,
            },
          },
        }),
        envelope('turn_complete', {
          turn_id: 't1',
          last_agent_message: 'All done.',
          duration_ms: 12_345,
        }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }

      const complete = events.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete).toMatchObject({
        type: 'complete',
        result: 'All done.',
        totalInputTokens: 1500,
        totalOutputTokens: 400,
      });

      // Tool calls and status events still flow through.
      const toolCalls = events.filter((e) => e.type === 'tool_use');
      expect(toolCalls).toHaveLength(2);
    });

    it('uses the most recent token_count snapshot when several arrive in a turn', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 999, output_tokens: 800 } },
        }),
        envelope('turn_complete', { turn_id: 't1', last_agent_message: 'ok' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      const complete = events.find((e) => e.type === 'complete');
      expect(complete).toMatchObject({ totalInputTokens: 999, totalOutputTokens: 800 });
    });

    it('falls back to last_token_usage when total_token_usage is absent', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        }),
        envelope('turn_complete', { turn_id: 't', last_agent_message: '' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events.find((e) => e.type === 'complete')).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 5,
      });
    });

    it('clears accumulated usage between turns', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        envelope('turn_complete', { turn_id: 't1', last_agent_message: 'a' }),
        envelope('turn_complete', { turn_id: 't2', last_agent_message: 'b' }),
      ]);
      const completes: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        if (event.type === 'complete') completes.push(event);
      }
      expect(completes).toHaveLength(2);
      // First completes with usage; second has no usage carried over.
      expect(completes[0]).toMatchObject({ totalInputTokens: 100 });
      expect((completes[1] as { totalInputTokens?: number }).totalInputTokens).toBeUndefined();
    });

    it('defaults to a generic result message when last_agent_message is empty', async () => {
      const stream = createMockStream([
        envelope('turn_complete', { turn_id: 't1', last_agent_message: null }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events[0]).toMatchObject({ type: 'complete', result: 'Codex turn complete' });
    });

    it('skips malformed JSONL lines without aborting', async () => {
      const stream = createMockStream([
        envelope('agent_message', { message: 'hi' }),
        'this is not json',
        envelope('turn_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('status');
      expect(events[1]?.type).toBe('complete');
    });

    it('skips empty/whitespace-only lines', async () => {
      const stream = createMockStream([
        '',
        '   ',
        envelope('agent_message', { message: 'x' }),
        envelope('turn_complete', { turn_id: 't', last_agent_message: 'y' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
    });
  });
});

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

    it('populates sessionId on session_configured when session_id is present', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'session_configured', session_id: 'sess-abc-123' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'status', sessionId: 'sess-abc-123' });
    });

    it('omits sessionId on session_configured when session_id is absent', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'session_configured' } },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      expect((e as any).sessionId).toBeUndefined();
    });

    it('maps turn_started to a status event', () => {
      const e = CodexStreamParser.mapEvent({ id: 's', msg: { type: 'turn_started' } }, 'pod-1');
      expect(e).toMatchObject({ type: 'status', message: 'Codex turn started' });
    });

    it('maps agent_message to a reasoning event with the message text', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_message', message: 'Looking at the code…' } },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'reasoning',
        text: 'Looking at the code…',
        isRaw: false,
      });
    });

    it('drops empty agent_message events', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_message', message: '' } },
        'pod-1',
      );
      expect(e).toBeNull();
    });

    it('maps assistant message events to reasoning instead of bootstrap status', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'message', role: 'assistant', content: 'Working through it' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'reasoning', text: 'Working through it', isRaw: false });
    });

    it('maps agent_reasoning to a reasoning event', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning', text: 'Need to refactor X' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'reasoning', text: 'Need to refactor X', isRaw: false });
    });

    it('maps agent_reasoning with 500-char text — untruncated', () => {
      const text = 'a'.repeat(500);
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning', text } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'reasoning', text, isRaw: false });
    });

    it('truncates agent_reasoning text over 4000 chars', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning', text: 'x'.repeat(5000) } },
        'pod-1',
      );
      // biome-ignore lint/suspicious/noExplicitAny: introspecting event in test
      const emitted = e as any;
      expect(emitted.type).toBe('reasoning');
      expect(emitted.text.length).toBe(4001); // 4000 chars + ellipsis char
      expect(emitted.text.endsWith('…')).toBe(true);
    });

    it('maps agent_reasoning_raw_content to a reasoning event with isRaw:true', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning_raw_content', text: 'raw reasoning output' } },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'reasoning', text: 'raw reasoning output', isRaw: true });
    });

    it('maps agent_reasoning_raw_content using content field when text is absent', () => {
      const e = CodexStreamParser.mapEvent(
        { id: 's', msg: { type: 'agent_reasoning_raw_content', content: 'raw via content field' } },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'reasoning',
        text: 'raw via content field',
        isRaw: true,
      });
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

    it('maps mcp_tool_call_begin using the mcp server-qualified tool name', () => {
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
        tool: 'mcp__autopod__ask_human',
        input: expect.objectContaining({ call_id: 'mcp-1', server: 'autopod', q: 'go?' }),
      });
    });

    it('preserves already-qualified mcp tool names', () => {
      const e = CodexStreamParser.mapEvent(
        {
          id: 's',
          msg: {
            type: 'mcp_tool_call_begin',
            call_id: 'mcp-1',
            invocation: { server: 'serena', tool: 'mcp__serena__find_symbol' },
          },
        },
        'pod-1',
      );
      expect(e).toMatchObject({ type: 'tool_use', tool: 'mcp__serena__find_symbol' });
    });

    it('maps response_item function calls with an MCP namespace to qualified MCP tools', () => {
      const e = CodexStreamParser.mapEvent(
        {
          timestamp: '2026-05-26T15:31:36.800Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'report_plan',
            namespace: 'mcp__escalation__',
            arguments: JSON.stringify({ summary: 'Deploy', steps: ['Run script'] }),
            call_id: 'call-mcp',
          },
        },
        'pod-1',
      );
      expect(e).toMatchObject({
        type: 'tool_use',
        tool: 'mcp__escalation__report_plan',
        input: expect.objectContaining({
          call_id: 'call-mcp',
          summary: 'Deploy',
          steps: ['Run script'],
        }),
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
        tool: 'mcp__autopod__ask_human',
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

    it('returns null for stateful events (token_count, turn_complete, task_complete)', () => {
      // These are folded together in parse() — single-event mapping skips.
      expect(
        CodexStreamParser.mapEvent({ id: 's', msg: { type: 'token_count' } }, 'pod-1'),
      ).toBeNull();
      expect(
        CodexStreamParser.mapEvent({ id: 's', msg: { type: 'turn_complete' } }, 'pod-1'),
      ).toBeNull();
      expect(
        CodexStreamParser.mapEvent({ id: 's', msg: { type: 'task_complete' } }, 'pod-1'),
      ).toBeNull();
    });

    it('returns null for high-frequency / interactive variants', () => {
      for (const type of [
        'agent_message_delta',
        'agent_reasoning_delta',
        'agent_reasoning_raw_content_delta',
        'exec_command_output_delta',
        'exec_approval_request',
        'apply_patch_approval_request',
        'thread_name_updated',
        'patch_apply_begin',
        'patch_apply_updated',
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
      expect(e).toMatchObject({ type: 'reasoning', text: 'flat shape', isRaw: false });
    });
  });

  describe('parse — stream-level integration', () => {
    it('emits AgentCompleteEvent on task_complete with accumulated token usage', async () => {
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
        envelope('task_complete', {
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

      // Tool calls and lifecycle status events still flow through.
      const toolCalls = events.filter((e) => e.type === 'tool_use');
      expect(toolCalls).toHaveLength(2);
    });

    it('uses the most recent token_count snapshot when several arrive before completion', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 999, output_tokens: 800 } },
        }),
        envelope('task_complete', { turn_id: 't1', last_agent_message: 'ok' }),
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
        envelope('task_complete', { turn_id: 't', last_agent_message: '' }),
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
        envelope('task_complete', { turn_id: 't1', last_agent_message: 'a' }),
        envelope('task_complete', { turn_id: 't2', last_agent_message: 'b' }),
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
        envelope('task_complete', { turn_id: 't1', last_agent_message: null }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events[0]).toMatchObject({ type: 'complete', result: 'Codex task complete' });
    });

    it('treats turn_complete as a non-terminal heartbeat', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 42, output_tokens: 7 } },
        }),
        envelope('turn_complete', { turn_id: 't1', last_agent_message: 'tool answer' }),
        envelope('task_complete', { turn_id: 't2', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({ type: 'status', message: 'Codex turn complete' });
      const completes = events.filter((e) => e.type === 'complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]).toMatchObject({
        type: 'complete',
        result: 'done',
        totalInputTokens: 42,
        totalOutputTokens: 7,
      });
    });

    it('skips malformed JSONL lines without aborting', async () => {
      const stream = createMockStream([
        envelope('agent_message', { message: 'hi' }),
        'this is not json',
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('reasoning');
      expect(events[1]?.type).toBe('complete');
    });

    it('skips empty/whitespace-only lines', async () => {
      const stream = createMockStream([
        '',
        '   ',
        envelope('agent_message', { message: 'x' }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'y' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
    });

    it('maps patch_apply_end single file (update) to one file_change event', async () => {
      const stream = createMockStream([
        envelope('patch_apply_end', { changes: { 'src/foo.ts': { type: 'update' } } }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      const fileChanges = events.filter((e) => e.type === 'file_change');
      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]).toMatchObject({
        type: 'file_change',
        path: 'src/foo.ts',
        action: 'modify',
      });
    });

    it('maps patch_apply_end multiple files with mixed actions', async () => {
      const stream = createMockStream([
        envelope('patch_apply_end', {
          changes: {
            'src/new.ts': { type: 'create' },
            'src/mod.ts': { type: 'update' },
            'src/old.ts': { type: 'delete' },
          },
        }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      const fileChanges = events.filter((e) => e.type === 'file_change');
      expect(fileChanges).toHaveLength(3);
      const byPath = Object.fromEntries(
        fileChanges.map((e) => [(e as { path: string }).path, (e as { action: string }).action]),
      );
      expect(byPath['src/new.ts']).toBe('create');
      expect(byPath['src/mod.ts']).toBe('modify');
      expect(byPath['src/old.ts']).toBe('delete');
    });

    it('patch_apply_begin and patch_apply_updated emit nothing', async () => {
      const stream = createMockStream([
        envelope('patch_apply_begin', { patch_id: 'p1' }),
        envelope('patch_apply_updated', { patch_id: 'p1' }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      expect(events.filter((e) => e.type === 'file_change')).toHaveLength(0);
      expect(events).toHaveLength(1); // only the complete event
    });

    it('computes costUsd at task_complete from session_configured model and token_count', async () => {
      const inputTokens = 1_000_000;
      const outputTokens = 500_000;
      const stream = createMockStream([
        envelope('session_configured', { session_id: 'sess-1', model: 'gpt-5' }),
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
        }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      const complete = events.find((e) => e.type === 'complete') as
        | { costUsd?: number }
        | undefined;
      expect(complete).toBeDefined();
      // Use the actual helper so the test doesn't drift if pricing changes.
      const { computeCost: cc } = await import('@autopod/shared');
      const expected = cc('gpt-5', inputTokens, outputTokens);
      expect(complete?.costUsd).toBeCloseTo(expected, 10);
    });

    it('emits complete and computes cached-input Codex cost from task_complete', async () => {
      const inputTokens = 1_000_000;
      const cachedInputTokens = 600_000;
      const outputTokens = 250_000;
      const stream = createMockStream([
        JSON.stringify({
          timestamp: '2026-05-25T14:21:57.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T14:25:17.117Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: inputTokens,
                cached_input_tokens: cachedInputTokens,
                output_tokens: outputTokens,
                reasoning_output_tokens: 1_000,
                total_tokens: inputTokens + outputTokens,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T14:25:17.130Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: 'Fixed it',
          },
        }),
      ]);

      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }

      const complete = events.find((e) => e.type === 'complete') as
        | { costUsd?: number }
        | undefined;
      expect(complete).toMatchObject({
        type: 'complete',
        result: 'Fixed it',
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
      });
      const { computeCostWithCache } = await import('@autopod/shared');
      const expected = computeCostWithCache(
        'gpt-5.3-codex',
        inputTokens,
        outputTokens,
        cachedInputTokens,
      );
      expect(complete?.costUsd).toBeCloseTo(expected, 10);
    });

    it('omits costUsd at task_complete when no session_configured preceded it', async () => {
      const stream = createMockStream([
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }
      const complete = events.find((e) => e.type === 'complete') as
        | { costUsd?: number }
        | undefined;
      // costUsd should be absent or 0 when the model is unknown
      expect(complete?.costUsd == null || complete.costUsd === 0).toBe(true);
    });

    it('sets costUsd to 0 and warns when model is not in MODEL_PRICING', async () => {
      const warnMessages: string[] = [];
      const warnLogger = {
        ...logger,
        warn: (obj: { msg?: string }) => {
          warnMessages.push(obj.msg ?? '');
        },
      };
      const stream = createMockStream([
        envelope('session_configured', { session_id: 'sess-2', model: 'unknown-model-xyz' }),
        envelope('token_count', {
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        envelope('task_complete', { turn_id: 't', last_agent_message: 'done' }),
      ]);
      const events: AgentEvent[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: test logger coercion
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', warnLogger as any)) {
        events.push(event);
      }
      const complete = events.find((e) => e.type === 'complete') as
        | { costUsd?: number }
        | undefined;
      expect(complete?.costUsd).toBe(0);
      expect(warnMessages.some((m) => m.includes('unknown-model-xyz'))).toBe(true);
    });

    it('maps Codex CLI 0.133 JSONL envelopes into agent activity', async () => {
      const stream = createMockStream([
        JSON.stringify({
          timestamp: '2026-05-25T08:09:12.624Z',
          type: 'session_meta',
          payload: { id: 'sess-123', cwd: '/workspace' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:12.632Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-1' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:16.673Z',
          type: 'turn_context',
          payload: { model: 'gpt-4o' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:25.898Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Inspecting the repo' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:25.912Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'rg memory', workdir: '/workspace' }),
            call_id: 'call-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:26.051Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'found it' },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:09:26.052Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1000,
                output_tokens: 50,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:11:03.560Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            changes: {
              '/workspace/packages/shared/src/types/task-summary.ts': { type: 'modify' },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-25T08:12:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: 'Done',
          },
        }),
      ]);

      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'pod-1', logger)) {
        events.push(event);
      }

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'status',
            message: 'Codex session ready',
            sessionId: 'sess-123',
          }),
          expect.objectContaining({ type: 'status', message: 'Codex turn started' }),
          expect.objectContaining({
            type: 'reasoning',
            text: 'Inspecting the repo',
            isRaw: false,
          }),
          expect.objectContaining({
            type: 'tool_use',
            tool: 'Bash',
            input: expect.objectContaining({
              call_id: 'call-1',
              command: 'rg memory',
              cwd: '/workspace',
            }),
          }),
          expect.objectContaining({
            type: 'tool_use',
            output: 'found it',
          }),
          expect.objectContaining({
            type: 'file_change',
            path: '/workspace/packages/shared/src/types/task-summary.ts',
            action: 'modify',
          }),
          expect.objectContaining({
            type: 'complete',
            result: 'Done',
            totalInputTokens: 1000,
            totalOutputTokens: 50,
          }),
        ]),
      );
    });
  });
});

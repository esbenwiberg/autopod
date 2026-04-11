import { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from './codex-stream-parser.js';

const logger = pino({ level: 'silent' });

function createMockStream(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

describe('CodexStreamParser', () => {
  describe('mapEvent', () => {
    it('parses task_start as status event', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'task_start', message: 'Starting task' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'status',
        timestamp: expect.any(String),
        message: 'Starting task',
      });
    });

    it('defaults task_start message when missing', () => {
      const event = CodexStreamParser.mapEvent({ type: 'task_start' }, 'test-id');
      expect(event).toEqual({
        type: 'status',
        timestamp: expect.any(String),
        message: 'Codex agent started',
      });
    });

    it('parses file_write for existing file as modify', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'file_write', path: 'src/index.ts', existed: true, diff: '+new line' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'file_change',
        timestamp: expect.any(String),
        path: 'src/index.ts',
        action: 'modify',
        diff: '+new line',
      });
    });

    it('parses file_write for new file as create', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'file_write', path: 'new-file.ts', existed: false },
        'test-id',
      );
      expect(event?.type).toBe('file_change');
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((event as any).action).toBe('create');
    });

    it('parses file_delete as file_change delete', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'file_delete', path: 'old-file.ts' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'file_change',
        timestamp: expect.any(String),
        path: 'old-file.ts',
        action: 'delete',
      });
    });

    it('parses file_read as tool_use', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'file_read', path: 'src/app.ts', content: 'const x = 1;' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'Read',
        input: { path: 'src/app.ts' },
        output: 'const x = 1;',
      });
    });

    it('truncates long file read content to 500 chars', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'file_read', path: 'big.ts', content: 'x'.repeat(10_000) },
        'test-id',
      );
      expect(event?.type).toBe('tool_use');
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((event as any).output.length).toBeLessThanOrEqual(500);
    });

    it('parses command_run as tool_use', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'command_run', command: 'npm test' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'Bash',
        input: { command: 'npm test' },
      });
    });

    it('parses command_output as tool_use with output', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'command_output', command: 'npm test', output: 'All tests passed' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'tool_use',
        timestamp: expect.any(String),
        tool: 'Bash',
        input: { command: 'npm test' },
        output: 'All tests passed',
      });
    });

    it('truncates long command output to 2000 chars', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'command_output', command: 'ls', output: 'y'.repeat(5_000) },
        'test-id',
      );
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((event as any).output.length).toBeLessThanOrEqual(2000);
    });

    it('parses message as status event', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'message', message: 'Thinking about the problem...' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'status',
        timestamp: expect.any(String),
        message: 'Thinking about the problem...',
      });
    });

    it('parses task_complete event', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'task_complete', result: 'All done' },
        'test-id',
      );
      expect(event).toEqual({
        type: 'complete',
        timestamp: expect.any(String),
        result: 'All done',
      });
    });

    it('parses error event', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'error', message: 'Rate limited', fatal: true },
        'test-id',
      );
      expect(event).toEqual({
        type: 'error',
        timestamp: expect.any(String),
        message: 'Rate limited',
        fatal: true,
      });
    });

    it('defaults error fatal to false', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'error', message: 'Transient issue' },
        'test-id',
      );
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((event as any).fatal).toBe(false);
    });

    it('returns null for unknown event types', () => {
      const event = CodexStreamParser.mapEvent(
        { type: 'unknown_thing', data: 'whatever' },
        'test-id',
        logger,
      );
      expect(event).toBeNull();
    });

    it('preserves original timestamp when provided', () => {
      const ts = '2026-03-16T10:00:00.000Z';
      const event = CodexStreamParser.mapEvent(
        { type: 'message', message: 'hi', timestamp: ts },
        'test-id',
      );
      expect(event?.timestamp).toBe(ts);
    });
  });

  describe('parse (stream)', () => {
    it('handles malformed JSONL lines gracefully', async () => {
      const stream = createMockStream([
        '{"type":"task_start","message":"hi"}',
        'not json at all',
        '{"type":"task_complete","result":"done"}',
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'test-id', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('status');
      expect(events[1]?.type).toBe('complete');
    });

    it('skips empty lines', async () => {
      const stream = createMockStream([
        '',
        '{"type":"message","message":"hello"}',
        '   ',
        '{"type":"task_complete","result":"bye"}',
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'test-id', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
    });

    it('skips unknown event types in stream', async () => {
      const stream = createMockStream([
        '{"type":"task_start","message":"go"}',
        '{"type":"internal_debug","info":"something"}',
        '{"type":"task_complete","result":"done"}',
      ]);
      const events: AgentEvent[] = [];
      for await (const event of CodexStreamParser.parse(stream, 'test-id', logger)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from './claude-stream-parser.js';

// Actual event shapes captured from `claude --output-format stream-json --verbose`
const SESSION_ID = 'test-session';

function fakeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {} } as unknown as import('pino').Logger;
}

describe('ClaudeStreamParser.mapEvent', () => {
  it('maps system init to Claude session initialized status', () => {
    const event = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({
      type: 'status',
      message: 'Claude session initialized (abc-123)',
    });
  });

  it('maps assistant text content to status event', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Claude' }],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({ type: 'status', message: 'Hello from Claude' });
  });

  it('skips assistant thinking blocks', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toBeNull();
  });

  it('maps assistant tool_use (non-file) to tool_use event', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: { command: 'echo hello' },
          },
        ],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({
      type: 'tool_use',
      tool: 'Bash',
      input: { command: 'echo hello' },
    });
  });

  it('maps assistant Edit tool_use to file_change modify event', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/workspace/src/foo.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({
      type: 'file_change',
      path: '/workspace/src/foo.ts',
      action: 'modify',
    });
  });

  it('maps assistant Write tool_use to file_change create event', () => {
    const event = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/workspace/new.ts', content: '// hi' },
          },
        ],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({ type: 'file_change', action: 'create' });
  });

  it('maps user tool_result to tool_use event with stdout output', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'hello\n',
            is_error: false,
          },
        ],
      },
      tool_use_result: { stdout: 'hello\n', stderr: '', interrupted: false },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({
      type: 'tool_use',
      tool: 'tool_result',
      input: { tool_use_id: 'toolu_01' },
      output: 'hello\n',
    });
  });

  it('returns null for user events without tool_result content', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'some user message' }],
      },
    };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toBeNull();
  });

  it('maps result event to complete', () => {
    const event = { type: 'result', subtype: 'success', result: 'Done!' };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({ type: 'complete', result: 'Done!' });
  });

  it('maps error event to fatal error', () => {
    const event = { type: 'error', error: { message: 'rate limit' } };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toMatchObject({ type: 'error', message: 'rate limit', fatal: true });
  });

  it('returns null for unknown event types', () => {
    const event = { type: 'rate_limit_event' };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toBeNull();
  });

  it('returns null for assistant with no content', () => {
    const event = { type: 'assistant', message: { role: 'assistant', content: [] } };
    const result = ClaudeStreamParser.mapEvent(event, SESSION_ID, fakeLogger());
    expect(result).toBeNull();
  });
});

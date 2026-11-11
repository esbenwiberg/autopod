import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCompleteEvent } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { nativeCompletionUsage, readNativeCompletionUsage } from './codex-completion-usage.js';

const complete: AgentCompleteEvent = {
  type: 'complete',
  timestamp: '2026-11-11T17:00:02Z',
  result: 'Done',
};
const record = (id: string, timestamp = '2026-11-11T17:00:01Z') => ({
  type: 'token_usage_record',
  timestamp,
  payload: {
    thread_id: 'thread',
    turn_id: 'turn',
    response_id: id,
    usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 },
    turn_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 },
  },
});
const terminal = (timestamp = '2026-11-11T17:00:02Z') => ({
  type: 'event_msg',
  timestamp,
  payload: { type: 'task_complete', last_agent_message: 'private text' },
});
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('native final-usage metadata selection', () => {
  it('requires a native terminal marker after the last provider response', () => {
    expect(nativeCompletionUsage(jsonl(record('a')), 'thread', complete)).toEqual({ native: true });
    expect(nativeCompletionUsage(jsonl(terminal(), record('a')), 'thread', complete)).toEqual({
      native: true,
    });
    expect(
      nativeCompletionUsage(jsonl(record('a'), terminal()), 'thread', complete).lines,
    ).toBeDefined();
  });

  it('does not turn an aborted native prefix into complete accounting', () => {
    const aborted = { type: 'event_msg', payload: { type: 'turn_aborted' } };
    expect(
      nativeCompletionUsage(jsonl(record('a'), terminal(), aborted), 'thread', complete),
    ).toEqual({ native: true });
  });

  it('excludes all old resumed-turn usage and completion markers', () => {
    const old = '2026-11-11T16:00:00Z';
    const selected = nativeCompletionUsage(
      jsonl(record('old', old), terminal(old), record('new'), terminal()),
      'thread',
      complete,
      Date.parse('2026-11-11T17:00:00Z'),
    );
    expect(selected.lines).toContain('new');
    expect(selected.lines).not.toContain('old');
    expect(selected.lines).not.toContain('private text');
    const oldTerminalOnly = nativeCompletionUsage(
      jsonl(record('old', old), terminal(old), record('new')),
      'thread',
      complete,
      Date.parse('2026-11-11T17:00:00Z'),
    );
    expect(oldTerminalOnly.lines).toBeUndefined();
  });

  it('never falls back to legacy completeness for a modern file whose response records are not flushed', () => {
    const header = { type: 'session_meta', payload: { cli_version: '0.160.1' } };
    expect(nativeCompletionUsage(jsonl(header), 'thread', complete)).toEqual({ native: true });
  });

  it('preserves legacy compatibility without claiming native evidence', () => {
    expect(
      nativeCompletionUsage(
        jsonl({ type: 'session_meta', payload: { cli_version: '0.142.0' } }),
        'thread',
        complete,
      ),
    ).toEqual({ native: false });
  });

  it('streams a 33 MiB transcript while retaining only native usage metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-final-metadata-'));
    try {
      const data = jsonl(
        { type: 'response_item', payload: { text: 'x'.repeat(33 * 1024 * 1024) } },
        record('a'),
        terminal(),
      );
      const file = join(root, 'rollout.jsonl');
      await writeFile(file, data);
      const selected = await readNativeCompletionUsage(
        file,
        Buffer.byteLength(data),
        'thread',
        complete,
        {},
        Date.now() + 5000,
      );
      expect(selected.lines).toContain('token_usage_record');
      expect(selected.lines?.length).toBeLessThan(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses an exact local append boundary instead of container clock assumptions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-final-boundary-'));
    try {
      const prior =
        jsonl({ type: 'response_item', payload: { text: 'old 😀' } }, record('old'), terminal()) +
        '\n';
      const data =
        prior + jsonl(record('new', '2026-11-11T16:59:58Z'), terminal('2026-11-11T16:59:59Z'));
      const file = join(root, 'rollout.jsonl');
      await writeFile(file, data);
      const selected = await readNativeCompletionUsage(
        file,
        Buffer.byteLength(data),
        'thread',
        complete,
        { offset: Buffer.byteLength(prior) },
        Date.now() + 5000,
      );
      expect(selected.lines).toContain('new');
      expect(selected.lines).not.toContain('old');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses malformed and foreign-thread evidence', () => {
    expect(() => nativeCompletionUsage('{broken', 'thread', complete)).toThrow();
    expect(() => nativeCompletionUsage(jsonl(record('a')), 'foreign', complete)).toThrow('Foreign');
  });
});

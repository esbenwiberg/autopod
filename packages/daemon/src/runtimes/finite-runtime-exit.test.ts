import { PassThrough } from 'node:stream';
import { type AgentEvent, AutopodError } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeRuntime } from './claude-runtime.js';
import { CopilotRuntime } from './copilot-runtime.js';

const logger = pino({ level: 'silent' });
afterEach(() => {
  vi.unstubAllEnvs();
});
function fixture(kind: 'claude-spawn' | 'claude-resume' | 'copilot', rejected = false) {
  vi.stubEnv('AUTOPOD_EXIT_CODE_TIMEOUT_MS', '10');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = rejected
    ? Promise.reject(new Error('Transport ended without exit'))
    : new Promise<number>(() => {});
  void exitCode.catch(() => {});
  const handle: StreamingExecResult = {
    stdout,
    stderr,
    exitCode,
    kill: vi.fn(async () => {
      throw new Error('Termination unavailable');
    }),
  };
  const cm = {
    execStreaming: vi.fn(async () => handle),
    writeFile: vi.fn(async () => {}),
  } as unknown as ContainerManager;
  const runtime =
    kind === 'copilot' ? new CopilotRuntime(logger, cm) : new ClaudeRuntime(logger, cm);
  const events =
    kind === 'claude-resume'
      ? runtime.resume('pod', 'Continue', 'original')
      : runtime.spawn({
          podId: 'pod',
          task: 'Retain work',
          containerId: 'original',
          model: 'fixture',
          reasoningEffort: 'auto',
          workDir: '/workspace',
          env: {},
        });
  return { stdout, stderr, cm, runtime, events };
}

describe('finite CLI exit evidence', () => {
  it.each(
    (['claude-spawn', 'claude-resume', 'copilot'] as const).flatMap((kind) =>
      [false, true].map((rejected) => ({ kind, rejected })),
    ),
  )(
    'retains output but rejects unverified $kind exit (rejected: $rejected)',
    async ({ kind, rejected }) => {
      const { stdout, stderr, events } = fixture(kind, rejected);
      const retained: AgentEvent[] = [];
      const consume = (async () => {
        for await (const event of events) retained.push(event);
      })();
      stdout.end(
        kind === 'copilot'
          ? 'Retain this output\n'
          : `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Retain this output' })}\n`,
      );
      stderr.end();
      await expect(consume).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
      expect(JSON.stringify(retained)).toContain('Retain this output');
      if (kind === 'copilot')
        expect(retained.some((event) => event.type === 'complete')).toBe(false);
    },
  );

  it.each(['claude-spawn', 'claude-resume', 'copilot'] as const)(
    'consumer return cannot release an unverified %s process',
    async (kind) => {
      const { stdout, stderr, events } = fixture(kind);
      const iterator = events[Symbol.asyncIterator]();
      const next = iterator.next();
      stdout.write(
        kind === 'copilot'
          ? 'Retain first output\n'
          : `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Retain first output' })}\n`,
      );
      const first = await next;
      expect(first.done).toBe(false);
      await expect(iterator.return?.()).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
      stdout.destroy();
      stderr.destroy();
    },
  );

  it('does not authorize missing-session fallback before observing Claude Resume exit', async () => {
    const { stdout, stderr, runtime, events } = fixture('claude-resume');
    if (!(runtime instanceof ClaudeRuntime)) throw new Error('Missing Claude fixture');
    runtime.setClaudeSessionId('pod', 'retained-session');
    const consume = (async () => {
      for await (const _event of events) {
        /* drain */
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    stderr.end('No conversation found with session ID: retained-session\n');
    stdout.end();
    await expect(consume).rejects.toBeInstanceOf(AutopodError);
    await expect(consume).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    expect(runtime.getClaudeSessionId('pod')).toBe('retained-session');
  });
});

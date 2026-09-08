import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { CopilotRuntime } from './copilot-runtime.js';

function fixture(code: number) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cm = {
    writeFile: vi.fn(async () => {}),
    execStreaming: vi.fn(async () => {
      entered();
      return { stdout, stderr, exitCode: Promise.resolve(code), kill: vi.fn(async () => {}) };
    }),
  } as unknown as ContainerManager;
  const events: AgentEvent[] = [];
  const runtime = new CopilotRuntime(pino({ level: 'silent' }), cm);
  const consume = (async () => {
    for await (const event of runtime.spawn({
      podId: 'pod',
      task: 'Keep output',
      model: 'fixture',
      reasoningEffort: 'auto',
      containerId: 'original',
      workDir: '/workspace',
      env: {},
    }))
      events.push(event);
  })();
  return { stdout, stderr, ready, events, consume };
}

it('finishes after observed exit when stderr never closes, with incomplete diagnostics explicit', async () => {
  const { stdout, stderr, ready, events, consume } = fixture(0);
  await ready;
  await Promise.resolve();
  stdout.end('Completed output\n');
  stderr.write('A diagnostic retained while its channel remains open');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      consume.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1500);
      }),
    ]);
    expect(completed).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          fatal: false,
          message: expect.stringContaining('stderr diagnostics incomplete'),
        }),
      ]),
    );
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  } finally {
    if (timer) clearTimeout(timer);
    stderr.end();
    await consume;
  }
});

it('does not treat truncated stderr as definitive provider failure evidence', async () => {
  const { stdout, stderr, ready, events, consume } = fixture(1);
  await ready;
  await Promise.resolve();
  stderr.end(`${'x'.repeat(100000)}\nYou have exhausted your premium requests.\n`);
  stdout.end('Retain output\n');
  await consume;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        fatal: false,
        message: expect.stringContaining('stderr diagnostics incomplete'),
      }),
    ]),
  );
  const failure = events.find((event) => event.type === 'error' && event.fatal);
  expect(failure).toMatchObject({ classification: { category: 'unknown', definitive: false } });
  expect(events.some((event) => event.type === 'complete')).toBe(false);
});

it.each(['close', 'error'] as const)(
  'marks stderr %s without EOF as incomplete despite observed nonzero process exit',
  async (ending) => {
    const { stdout, stderr, ready, events, consume } = fixture(1);
    await ready;
    await Promise.resolve();
    stderr.write('You have exhausted your premium requests.\n');
    if (ending === 'error') stderr.emit('error', new Error('Diagnostic channel failed'));
    else stderr.destroy();
    stdout.end('Retain output\n');
    await consume;
    expect(events.find((event) => event.type === 'error' && event.fatal)).toMatchObject({
      classification: { category: 'unknown', definitive: false },
    });
    expect(stderr.listenerCount('data')).toBe(0);
    expect(() => stderr.emit('error', new Error('Late diagnostic transport error'))).not.toThrow();
    stderr.destroy();
  },
);

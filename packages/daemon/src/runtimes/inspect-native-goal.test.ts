import { PassThrough, Writable } from 'node:stream';
import type { NativeGoalObservation } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { inspectNativeGoal } from './inspect-native-goal.js';

it('prepares the isolated Codex home before inspection and never loads or resumes a thread', async () => {
  const homes = new Set<string>();
  const methods: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve;
  });
  const execInContainer = vi.fn(async (_id: string, command: string[]) => {
    if (command[0] === 'mkdir') homes.add(command[3] ?? '');
    if (command[0] === 'rm') homes.delete(command[3] ?? '');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const execStreaming = vi.fn(async (_id: string, command: string[]) => {
    const home = command.find((arg) => arg.startsWith('CODEX_HOME='))?.slice(11);
    if (!home || !homes.has(home)) throw new Error('CODEX_HOME does not exist');
    return {
      stdout,
      stderr,
      exitCode,
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const rpc = JSON.parse(chunk.toString());
          methods.push(rpc.method);
          if (rpc.id) {
            const result =
              rpc.method === 'thread/goal/get'
                ? {
                    goal: {
                      threadId: 'native',
                      objective: 'Proof',
                      status: 'paused',
                      tokenBudget: 1000,
                      tokensUsed: 0,
                      timeUsedSeconds: 0,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  }
                : rpc.method === 'thread/read'
                  ? { thread: { id: 'native', path: null } }
                  : {};
            stdout.write(`${JSON.stringify({ id: rpc.id, result })}\n`);
          }
          done();
        },
      }),
      kill: async () => {
        stdout.end();
        stderr.end();
        exited(0);
      },
    };
  });
  const manager = {
    execInContainer,
    execStreaming,
    readFile: vi.fn(),
  } as unknown as ContainerManager;
  const observed: NativeGoalObservation[] = [];
  await inspectNativeGoal({
    manager,
    containerId: 'sandbox',
    sessionId: 'native',
    hooks: { processCreated() {}, processStarted() {} },
    observe: (value) => observed.push(value),
  });
  expect(observed.length).toBeGreaterThan(0);
  expect(
    observed.every((value) => value.nativeStatus === 'paused' && value.cumulativeTokens === 0),
  ).toBe(true);
  expect(homes.size).toBe(0);
  expect(methods).toContain('thread/goal/get');
  expect(
    methods.some((method) =>
      ['thread/start', 'thread/resume', 'turn/start', 'thread/goal/set'].includes(method),
    ),
  ).toBe(false);
});

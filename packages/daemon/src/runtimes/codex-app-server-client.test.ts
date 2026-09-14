import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { codexGoalObservation } from './codex-native-goal.js';

function harness(timeout = 1000) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const writes: Array<Record<string, unknown>> = [];
  stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())));
  let exit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn(async () => {
    exit(0);
    stdout.end();
    stderr.end();
  });
  const client = new CodexAppServerClient({ stdout, stderr, stdin, exitCode, kill }, timeout);
  return { client, writes, stdout, kill };
}

describe('Codex native RPC transport', () => {
  it('correlates split and out-of-order responses while preserving native goal events', async () => {
    const h = harness();
    try {
      const first = h.client.request('thread/goal/get', { threadId: 'thread' });
      const second = h.client.request('thread/read', { threadId: 'thread' });
      await vi.waitFor(() => expect(h.writes).toHaveLength(2));
      h.stdout.write('{"id":2,"result":{"thread":');
      h.stdout.write(
        '{"id":"thread"}}}\n{"method":"thread/goal/updated","params":{"goal":"observation"}}\n',
      );
      h.stdout.write('{"id":1,"result":{"goal":null}}\n');
      expect(await first).toEqual({ goal: null });
      expect(await second).toEqual({ thread: { id: 'thread' } });
      expect((await h.client.events()[Symbol.asyncIterator]().next()).value).toEqual({
        method: 'thread/goal/updated',
        params: { goal: 'observation' },
      });
    } finally {
      await h.client.close();
    }
  });
  it('declines unexpected permission requests instead of granting authority', async () => {
    const h = harness();
    try {
      h.stdout.write(
        '{"id":"permission","method":"item/permissions/requestApproval","params":{"permissions":"all"}}\n',
      );
      await vi.waitFor(() => expect(h.writes).toHaveLength(1));
      expect(h.writes[0]).toMatchObject({ id: 'permission', error: { code: -32601 } });
    } finally {
      await h.client.close();
    }
  });
  it('does not retry a goal mutation after a response timeout', async () => {
    const h = harness(20);
    try {
      await expect(
        h.client.request('thread/goal/set', { threadId: 'thread', status: 'active' }),
      ).rejects.toMatchObject({ code: 'RESPONSE_UNCERTAIN' });
      await expect(
        h.client.request('thread/goal/set', { threadId: 'thread', status: 'active' }),
      ).rejects.toThrow('reconcile');
      expect(h.writes).toHaveLength(1);
    } finally {
      await h.client.close();
    }
  });
  it('rejects a malformed stream without leaking its contents into errors', async () => {
    const h = harness();
    try {
      const response = h.client.request('initialize', {});
      const assertion = expect(response).rejects.toMatchObject({ code: 'INVALID_PROTOCOL' });
      h.stdout.write('credential-fixture-not-json\n');
      await assertion;
    } finally {
      await h.client.close();
    }
  });
  it('maps native completion and budget states and refuses unknown success-like text', () => {
    const native = {
      threadId: 'thread',
      objective: 'Tests pass',
      status: 'complete',
      tokenBudget: 200,
      tokensUsed: 150,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(codexGoalObservation(native, 1)).toMatchObject({
      state: 'achieved',
      cumulativeTokens: 150,
    });
    expect(codexGoalObservation({ ...native, status: 'budgetLimited' }, 2).state).toBe(
      'budget-exhausted',
    );
    expect(() => codexGoalObservation({ ...native, status: 'success' }, 3)).toThrow();
  });
});

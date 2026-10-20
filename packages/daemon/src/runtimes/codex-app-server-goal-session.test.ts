import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerGoalSession } from './codex-app-server-goal-session.js';
import captured from './fixtures/codex-goal-usage-live.json';
const native = {
  threadId: 'native',
  objective: 'Tests pass',
  status: 'paused',
  tokenBudget: 200,
  tokensUsed: 100,
  timeUsedSeconds: 5,
  createdAt: 1,
  updatedAt: 2,
};
function fixture(readRollout?: (path: string) => Promise<string>) {
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'initialize') return {};
    if (method === 'thread/resume' || method === 'thread/start')
      return { thread: { id: 'native' } };
    if (method === 'thread/goal/get') return { goal: native };
    if (method === 'thread/read')
      return {
        thread: { id: 'native', path: '/home/autopod/.codex/sessions/rollout-native.jsonl' },
      };
    if (method === 'thread/goal/set') return { goal: { ...native, ...(params as object) } };
    throw new Error('Unexpected method');
  });
  const client = {
    request,
    notify: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    async *events() {
      yield {
        method: 'turn/completed',
        params: { threadId: 'native', turn: { status: 'completed' } },
      };
      yield {
        method: 'thread/goal/updated',
        params: { threadId: 'native', goal: { ...native, status: 'active' } },
      };
      yield {
        method: 'thread/goal/updated',
        params: {
          threadId: 'native',
          goal: { ...native, status: 'complete', tokensUsed: 120, updatedAt: 3 },
        },
      };
    },
  };
  const session = new CodexAppServerGoalSession(
    client,
    { model: 'model', cwd: '/workspace', developerInstructions: 'Use scoped AutoPod tools' },
    readRollout,
  );
  return { session, client };
}
describe('native Codex Goal session', () => {
  it('replays the actual native canary and accounts for cache and the post-completion response', async () => {
    let goal = structuredClone(captured.initialGoal);
    let total = 13230;
    let closed = false;
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (closed) throw new Error('No live RPC after exit');
      if (method === 'initialize') return {};
      if (method === 'thread/goal/get') return { goal };
      if (method === 'thread/goal/set') {
        goal = { ...goal, ...(params as object) };
        return { goal };
      }
      if (method === 'thread/resume' || method === 'thread/read')
        return {
          thread: { id: goal.threadId, path: '/home/autopod/.codex/sessions/rollout-live.jsonl' },
        };
      throw new Error('Unexpected native RPC');
    });
    const client = {
      request,
      notify: vi.fn(async () => {}),
      close: vi.fn(async () => {
        closed = true;
      }),
      async *events() {
        for (const frame of captured.events) {
          if (frame.params.goal) goal = { ...goal, ...frame.params.goal };
          if (frame.params.tokenUsage) total = frame.params.tokenUsage.total.totalTokens;
          yield frame;
        }
      },
    };
    const session = new CodexAppServerGoalSession(
      client,
      { model: 'gpt-6.1-sol', cwd: '/workspace', developerInstructions: '' },
      async () =>
        [
          JSON.stringify({ type: 'session_meta', payload: { id: goal.threadId } }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
          }),
          '',
        ].join('\n'),
    );
    await session.open(goal.threadId);
    await session.resume(60000 - total);
    let terminal: Awaited<ReturnType<typeof session.get>> = null;
    for await (const value of session.observations()) {
      if (value.state === 'achieved') {
        terminal = value;
        break;
      }
    }
    expect(terminal).toMatchObject({ state: 'achieved', cumulativeTokens: 59006 });
    expect(goal.tokensUsed).toBe(21886);
    await session.stop();
    total = captured.finalRolloutTotal;
    expect(await session.reconcileUsage()).toMatchObject({
      state: 'achieved',
      cumulativeTokens: 75330,
    });
  });
  it('locates a new thread rollout before terminal exit so final accounting needs no live RPC', async () => {
    const { session, client } = fixture(async () =>
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'native' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 75330 } } },
        }),
        '',
      ].join('\n'),
    );
    await session.open(null);
    const results = [];
    for await (const event of session.observations()) results.push(event);
    expect(results.at(-1)).toMatchObject({ state: 'achieved', cumulativeTokens: 75330 });
    expect(client.request).toHaveBeenCalledWith('thread/read', {
      threadId: 'native',
      includeTurns: false,
    });
    await session.stop();
    const requests = client.request.mock.calls.length;
    expect(await session.reconcileUsage()).toMatchObject({ cumulativeTokens: 75330 });
    expect(client.request).toHaveBeenCalledTimes(requests);
  });
  it('recovers full cached usage without loading a thread and keeps native budget units separate', async () => {
    const rollout = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'native' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 75330 } } },
      }),
      '',
    ].join('\n');
    const read = vi.fn(async () => rollout);
    const { session, client } = fixture(read);
    await session.openInspection('native');
    expect(await session.get()).toMatchObject({ cumulativeTokens: 75330, nativeStatus: 'paused' });
    expect(client.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
    expect(read).toHaveBeenCalledWith('/home/autopod/.codex/sessions/rollout-native.jsonl');
    await session.stop();
    const prior = client.request.mock.calls.length;
    expect(await session.reconcileUsage()).toMatchObject({ cumulativeTokens: 75330 });
    expect(client.request).toHaveBeenCalledTimes(prior);
  });

  it('advances usage on full-thread telemetry and reconciles the final response after exit', async () => {
    let tokens = 100;
    const { session, client } = fixture(async () =>
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'native' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { total_tokens: tokens } } },
        }),
        '',
      ].join('\n'),
    );
    await session.open('native');
    await session.resume(500);
    client.events = async function* () {
      yield {
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'native', tokenUsage: { total: { totalTokens: 59006 } } },
      };
      yield {
        method: 'thread/goal/updated',
        params: { threadId: 'native', goal: { ...native, status: 'complete', tokensUsed: 21886 } },
      };
    };
    const observed = [];
    for await (const event of session.observations()) observed.push(event);
    expect(observed.at(-1)).toMatchObject({ state: 'achieved', cumulativeTokens: 59006 });
    await session.stop();
    tokens = 75330;
    expect(await session.reconcileUsage()).toMatchObject({
      state: 'achieved',
      cumulativeTokens: 75330,
    });
    // Remaining whole-pod tokens are additional to the native uncached baseline, not thread total.
    expect(client.request).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 'native',
      origin: 'user',
      status: 'active',
      tokenBudget: 600,
    });
  });

  it('changes only the budget, including removing it, without resuming a paused Goal', async () => {
    const { session, client } = fixture();
    await session.open('native');
    await session.get();
    expect(await session.updateBudget(250)).toMatchObject({
      state: 'paused',
      cumulativeTokens: 100,
    });
    expect(client.request).toHaveBeenLastCalledWith('thread/goal/set', {
      origin: 'user',
      threadId: 'native',
      tokenBudget: 350,
    });
    expect(await session.updateBudget(null)).toMatchObject({
      state: 'paused',
      cumulativeTokens: 100,
    });
    expect(client.request).toHaveBeenLastCalledWith('thread/goal/set', {
      origin: 'user',
      threadId: 'native',
      tokenBudget: null,
    });
  });
  it('inspects and pauses stored state without loading a thread and cannot start continuation', async () => {
    const { session, client } = fixture();
    await session.openInspection('native');
    expect(await session.get()).toMatchObject({ nativeSessionId: 'native', cumulativeTokens: 100 });
    await session.pause();
    await expect(session.start('other', 100)).rejects.toThrow('INSPECTION_ONLY');
    await expect(session.resume(100)).rejects.toThrow('INSPECTION_ONLY');
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'thread/goal/get',
      'thread/goal/set',
    ]);
  });
  it('pauses an unloaded active Goal before thread resume can restart native work', async () => {
    const { session, client } = fixture();
    let saved = { ...native, status: 'active' };
    client.request.mockImplementation(async (method, params) => {
      if (method === 'initialize') return {};
      if (method === 'thread/goal/get') return { goal: saved };
      if (method === 'thread/goal/set') {
        saved = { ...saved, ...(params as object) };
        return { goal: saved };
      }
      if (method === 'thread/resume') {
        expect(saved.status).toBe('paused');
        return { thread: { id: 'native' } };
      }
      throw new Error('Unexpected method');
    });
    await session.open('native');
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'thread/goal/get',
      'thread/goal/set',
      'thread/resume',
    ]);
    expect(saved).toMatchObject({
      status: 'paused',
      tokensUsed: 100,
      tokenBudget: 200,
      objective: 'Tests pass',
    });
    await session.resume(25);
    expect(saved).toMatchObject({ status: 'active', tokenBudget: 125, tokensUsed: 100 });
  });
  it('never resumes the thread after an uncertain unloaded Goal pause', async () => {
    const { session, client } = fixture();
    client.request.mockImplementation(async (method) => {
      if (method === 'initialize') return {};
      if (method === 'thread/goal/get') return { goal: { ...native, status: 'active' } };
      throw new Error('Pause response uncertain');
    });
    await expect(session.open('native')).rejects.toThrow('Pause response uncertain');
    expect(client.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
  });
  it('reconciles an ambiguous same-timestamp notification instead of undoing a confirmed resume', async () => {
    const { session, client } = fixture();
    await session.open('native');
    await session.get();
    await session.resume(50);
    client.request.mockImplementation(async (method) => {
      if (method === 'thread/goal/get') return { goal: { ...native, status: 'active' } };
      throw new Error('Unexpected method');
    });
    client.events = async function* () {
      yield {
        method: 'thread/goal/updated',
        params: { threadId: 'native', goal: { ...native, status: 'paused' } },
      };
    };
    const results = [];
    for await (const event of session.observations()) results.push(event);
    expect(results).toEqual([]);
    expect(client.request).toHaveBeenLastCalledWith('thread/goal/get', { threadId: 'native' });
  });
  it('resumes the same thread without replacing the objective or resetting its counters', async () => {
    const { session, client } = fixture();
    await session.open('native');
    await session.get();
    await session.resume(50);
    expect(client.request).toHaveBeenLastCalledWith('thread/goal/set', {
      origin: 'user',
      threadId: 'native',
      status: 'active',
      tokenBudget: 150,
    });
    const observed = [];
    for await (const event of session.observations()) observed.push(event);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ state: 'achieved', cumulativeTokens: 120 });
    expect(client.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
    await session.stop();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it('rejects a returned thread identity mismatch before any native Goal mutation', async () => {
    const { session, client } = fixture();
    await expect(session.open('other')).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect(
      client.request.mock.calls.filter(([method]) => method === 'thread/goal/set'),
    ).toHaveLength(0);
  });
});

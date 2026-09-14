import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerGoalSession } from './codex-app-server-goal-session.js';
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
function fixture() {
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'initialize') return {};
    if (method === 'thread/resume' || method === 'thread/start')
      return { thread: { id: 'native' } };
    if (method === 'thread/goal/get') return { goal: native };
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
  const session = new CodexAppServerGoalSession(client, {
    model: 'model',
    cwd: '/workspace',
    developerInstructions: 'Use scoped AutoPod tools',
  });
  return { session, client };
}
describe('native Codex Goal session', () => {
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

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRuntime } from '../runtimes/claude-runtime.js';
import { createAgentExecutionFixture } from '../test-utils/agent-execution-helpers.js';

const POD = 'prepare';
const SESSION = 'native-claude';
const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  vi.restoreAllMocks();
});

function fixture(disk = false) {
  const f = createAgentExecutionFixture(disk);
  fixtures.push(f);
  f.running();
  return f;
}

function invocation(
  f: ReturnType<typeof fixture>,
  frames: object[],
  resumedSession?: string,
  exitCode = 0,
) {
  const stdout = new PassThrough();
  stdout.end(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));
  const stderr = new PassThrough();
  stderr.end();
  vi.mocked(f.cm.execStreaming).mockResolvedValueOnce({
    stdout,
    stderr,
    exitCode: Promise.resolve(exitCode),
    kill: vi.fn(async () => {}),
  });
  const runtime = new ClaudeRuntime(f.deps.logger, f.cm);
  if (resumedSession) {
    runtime.setClaudeSessionId(POD, resumedSession);
    return runtime.resume(POD, 'Continue', 'container-123');
  }
  return runtime.spawn({
    podId: POD,
    containerId: 'container-123',
    model: 'sonnet',
    reasoningEffort: 'auto',
    workDir: '/workspace',
    env: {},
    task: 'Synthetic task',
  });
}

const init = (session = SESSION) => ({ type: 'system', subtype: 'init', session_id: session });
// Projected from a no-credentials Claude Code 2.1.318 fixture (see daemon CLAUDE.md).
// `usage` resets on each result. Deliberately unequal observations also catch token differencing.
const result = (id: string, total: number | undefined, units: number, delta?: number) => ({
  type: 'result',
  subtype: 'success',
  uuid: id,
  result: id,
  total_cost_usd: total,
  model_usage_since_last_result: delta === undefined ? undefined : { sonnet: { costUSD: delta } },
  usage: {
    input_tokens: 100 * units,
    output_tokens: 10 * units,
    cache_read_input_tokens: 200 * units,
    cache_creation_input_tokens: 300 * units,
  },
});
const working = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Still working' }] },
};

describe('Claude result accounting', () => {
  it('sums per-result tokens, charges cumulative cost once, and resumes from the stored cursor after restart', async () => {
    const f = fixture(true);
    const first = result('first', 0.004905, 3, 0.004905);
    expect(
      await f.consumer.consumeAgentEvents(
        POD,
        invocation(f, [init(), first, first, working, result('second', 0.011445, 4, 0.00654)]),
      ),
    ).toBe('completed');
    expect(f.pod()).toMatchObject({
      inputTokens: 4200,
      outputTokens: 70,
      tokenTelemetryAccuracy: 'complete',
      phaseTokenUsage: {
        agent_initial: {
          inputTokens: 4200,
          outputTokens: 70,
          cachedInputTokens: 1400,
          cacheCreationInputTokens: 2100,
        },
      },
    });
    expect(f.pod().costUsd).toBeCloseTo(0.011445);
    expect(f.pod().phaseTokenUsage?.agent_initial?.costUsd).toBeCloseTo(0.011445);
    expect(f.repo.list(POD)[0]?.costUsd).toBeCloseTo(0.011445);
    const activities = f.deps.eventRepo.getForSession(POD, { type: 'pod.agent_activity' });
    expect(JSON.stringify(activities)).not.toContain('claude_result_usage');
    expect(JSON.stringify(activities)).not.toContain('"result":"first"');
    expect(JSON.stringify(activities)).toContain('"result":"second"');

    const { pods } = f.reopen();
    expect(pods.claudeCostCursor?.get(POD, SESSION)).toBeCloseTo(0.011445);
    // Simulate a CLI that emits only the cumulative cost, even after resume.
    const manager = f.manager();
    expect(
      await manager.consumeAgentEvents(
        POD,
        invocation(f, [init(), result('resumed', 0.01308, 1)], SESSION),
        1,
      ),
    ).toBe('completed');
    expect(f.pod()).toMatchObject({ inputTokens: 4800, outputTokens: 80 });
    expect(f.pod().costUsd).toBeCloseTo(0.01308);
    expect(f.pod().phaseTokenUsage?.agent_rework_1?.costUsd).toBeCloseTo(0.001635);
    expect(f.deps.providerAttemptRepo?.list(POD).at(-1)?.costUsd).toBeCloseTo(0.001635);

    // Replacement session starts at zero, independently of pod totals.
    expect(
      await manager.consumeAgentEvents(
        POD,
        invocation(f, [init('replacement'), result('fresh', 0.00327, 2)], SESSION),
        2,
      ),
    ).toBe('completed');
    expect(f.pod().claudeSessionId).toBe('replacement');
    expect(f.pod().costUsd).toBeCloseTo(0.01635);
  });

  it('records a zero baseline at fresh init even if there is no result before restart', async () => {
    const f = fixture(true);
    const source = invocation(f, [init(), working], undefined, 143);
    expect(
      await f.consumer.consumeAgentEvents(
        POD,
        (async function* () {
          for await (const event of source) {
            yield event;
            if (event.type === 'status' && event.sessionId)
              f.consumerCaptured.pauseIntents.set(POD, Symbol('pause before the first result'));
          }
        })(),
      ),
    ).toBe('paused');
    expect(f.pod().costUsd).toBe(0);
    const { pods } = f.reopen();
    expect(pods.claudeCostCursor?.get(POD, SESSION)).toBe(0);
    await f
      .manager()
      .consumeAgentEvents(
        POD,
        invocation(f, [init(), result('resumed', 0.004905, 2, 0.00327)], SESSION),
      );
    // If the transcript restores spend unobserved before restart, catch up
    // rather than using only the cost of the new turn.
    expect(f.pod().costUsd).toBeCloseTo(0.004905);
    expect(f.pod()).toMatchObject({ inputTokens: 1200, tokenTelemetryAccuracy: 'partial' });
  });

  it('rolls back the cursor and pod totals when the provider-attempt write fails', async () => {
    const f = fixture();
    const updateActive = f.repo.updateActive.bind(f.repo);
    vi.spyOn(f.repo, 'updateActive').mockImplementation((podId, usage) => {
      if (usage.costUsd > 0) throw new Error('Synthetic accounting write failure');
      return updateActive(podId, usage);
    });
    await expect(
      f.consumer.consumeAgentEvents(POD, invocation(f, [init(), result('first', 0.001635, 1)])),
    ).rejects.toThrow('Synthetic accounting write failure');
    expect(f.pod()).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(f.podRepo.claudeCostCursor?.get(POD, SESSION)).toBe(0);
  });

  it.each([
    undefined,
    0.00327,
  ])('does not bill inherited history for a legacy resume (native delta %s)', async (delta) => {
    const f = fixture();
    f.podRepo.update(POD, { claudeSessionId: SESSION, costUsd: 0.02 });
    expect(
      await f.consumer.consumeAgentEvents(
        POD,
        invocation(
          f,
          [init(), result('resumed', 0.004905, 2, delta), working, result('following', 0.00654, 1)],
          SESSION,
        ),
      ),
    ).toBe('completed');
    expect(f.pod().costUsd).toBeCloseTo(0.02 + (delta ?? 0) + 0.001635);
    expect(f.pod().inputTokens).toBe(1800);
  });

  it('uses the native delta if a resumed transcript restores a lower balance', async () => {
    const f = fixture();
    f.podRepo.update(POD, { claudeSessionId: SESSION, costUsd: 0.01 });
    f.podRepo.claudeCostCursor?.set(POD, SESSION, 0.01);
    await f.consumer.consumeAgentEvents(
      POD,
      invocation(
        f,
        [
          init(),
          result('restored', 0.009, 1, 0.001),
          { type: 'result', total_cost_usd: 0.0095 }, // cost-only frames also update the phase
        ],
        SESSION,
      ),
    );
    expect(f.pod().costUsd).toBeCloseTo(0.0115);
    expect(f.pod().phaseTokenUsage?.agent_initial?.costUsd).toBeCloseTo(0.0015);
    expect(f.pod().tokenTelemetryAccuracy).toBe('partial');
  });

  it('retains the cursor across missing observations and does not re-bill native-only cost', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents(
      POD,
      invocation(f, [
        init(),
        result('first', 0.001635, 1),
        { type: 'result', uuid: 'missing' },
        result('native-only', undefined, 2, 0.00327),
        result('cumulative', 0.00981, 3),
      ]),
    );
    expect(f.pod().costUsd).toBeCloseTo(0.00981);
    expect(f.pod()).toMatchObject({
      inputTokens: 3600,
      outputTokens: 60,
      tokenTelemetryAccuracy: 'partial',
    });
  });

  it.each([
    'active',
    'background pending',
  ] as const)('keeps observed spend when interrupted (%s)', async (mode) => {
    const f = fixture();
    // An intermediate observation is not a normal completion/budget check,
    // even when its measured usage crosses the budget.
    f.podRepo.update(POD, { tokenBudget: 100 });
    const first = result('intermediate', 0.001635, 1);
    const frames =
      mode === 'active'
        ? [init(), first, working]
        : [init(), { type: 'system', subtype: 'task_started', task_id: 'background' }, first];
    expect(await f.manager().consumeAgentEvents(POD, invocation(f, frames, undefined, 143))).toBe(
      'failed',
    );
    expect(f.pod()).toMatchObject({
      status: 'failed',
      pauseReason: null,
      inputTokens: 600,
      outputTokens: 10,
      tokenTelemetryAccuracy: 'partial',
      failureReason: expect.stringContaining('The turn is incomplete'),
    });
    expect(f.pod().costUsd).toBeCloseTo(0.001635);
    expect(f.podRepo.claudeCostCursor?.get(POD, SESSION)).toBeCloseTo(0.001635);
    expect(f.repo.list(POD)[0]?.costUsd).toBeCloseTo(0.001635);
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
  });
});

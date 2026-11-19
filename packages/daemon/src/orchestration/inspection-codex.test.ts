import type { Logger } from 'pino';
import { expect, it, vi } from 'vitest';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { bindInspectionCodex, inspectionCodexPin } from './inspection-codex.js';

const pin = inspectionCodexPin.parse({
  kind: 'inspection-codex-v1',
  accountId: 'openai-projectum',
  model: 'gpt-5.6-sol',
  reasoning: 'low',
  budgetMode: 'request-time',
  timeoutMs: 30000,
});
const body = {
  model: pin.model,
  system: 'return JSON',
  max_tokens: 0,
  messages: [{ role: 'user', content: '{"phase":"kickoff"}' }],
};
function setup() {
  const accounts = {
    get: vi.fn((id: string) => ({
      id,
      name: id,
      provider: 'openai' as const,
      credentials: {
        provider: 'openai' as const,
        authMode: 'chatgpt' as const,
        authJson: JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { account_id: 'fixture', access_token: 'test-only' },
        }),
      },
      failoverPolicy: null,
      createdAt: '',
      updatedAt: '',
      lastAuthenticatedAt: null,
      lastUsedAt: null,
    })),
  };
  const health = {
    current: () => ({
      state: 'ok' as const,
      reason: null,
      source: null,
      observedAt: null,
      actor: null,
    }),
  };
  const warn = vi.fn(),
    reserve = vi.fn();
  const wire = vi.fn<typeof fetch>(async () => {
    expect(reserve.mock.calls.length).toBeGreaterThan(0);
    const response = {
      model: pin.model,
      status: 'completed',
      usage: { input_tokens: 199, output_tokens: 571, total_tokens: 770 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"children":[],"waitFor":null}' }],
        },
      ],
    };
    return new Response(
      'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const provider = bindInspectionCodex(pin, accounts, health, { warn } as unknown as Logger, wire);
  return {
    provider,
    wire,
    reserve,
    accounts,
    warn,
    call: () => provider.requestTimeTurn(body, reserve, 'sha256:' + 'a'.repeat(64)),
  };
}
it('sends only the tool-free isolated wire after reservation; measures uncapped usage', async () => {
  const x = setup();
  expect(x.accounts.get).not.toHaveBeenCalled();
  expect((await x.call()).usage.output_tokens).toBe(571);
  const [url, opts] = x.wire.mock.calls[0]!;
  expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(opts?.redirect).toBe('error');
  expect(opts?.signal).toBeInstanceOf(AbortSignal);
  const b = JSON.parse(String(opts?.body));
  expect(b.tools).toEqual([]);
  expect(b.max_output_tokens).toBeUndefined();
  expect(x.accounts.get.mock.calls.every(([id]) => id === pin.accountId)).toBe(true);
  await x.call();
  await expect(x.call()).rejects.toThrow('not-sent');
  expect(x.reserve).toHaveBeenCalledTimes(2);
  expect(x.wire).toHaveBeenCalledTimes(2);
});
it('rejects oversized wire and lost authority before send; never retries a 429', async () => {
  const x = setup();
  await expect(
    x.provider.requestTimeTurn({ ...body, system: 'a'.repeat(8192) }, x.reserve, 'x'),
  ).rejects.toThrow('not-sent');
  expect(x.reserve).not.toHaveBeenCalled();
  x.reserve.mockImplementationOnce(() => {
    throw Error('canceled');
  });
  await expect(x.call()).rejects.toThrow('not-sent');
  expect(x.wire).not.toHaveBeenCalled();
  x.wire.mockResolvedValueOnce(new Response('secret provider text', { status: 429 }));
  await expect(x.call()).rejects.toThrow('controller-provider-http-429');
  expect(x.wire).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(x.warn.mock.calls)).not.toContain('secret provider text');
});
it('retains the reservation without sending if the clock advances during SQLite reservation', async () => {
  const x = setup();
  let now = 100;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    x.reserve.mockImplementationOnce(() => {
      now += 30_001;
    });
    await expect(x.call()).rejects.toThrow('controller-provider-aborted');
    expect(x.reserve).toHaveBeenCalledOnce();
    expect(x.wire).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
it('pins the kickoff principal in SQLite, permits same-account refresh and never replays a lost second response', async () => {
  const { f, cp, host, request } = await setupOrchestrationRun(6, 1);
  await host().ledger.kickoff(cp, { inspect: request });
  const config = {
    mission: 'inspect',
    recipes: { inspect: '@inspect' },
    routeId: 'inspection-codex-v1',
    limits: { turns: 2, workers: 8, outputTokens: 'request-time-30s' as const },
  };
  const one = setup();
  await expect(
    host().tickController(
      cp.run,
      { ...config, limits: { ...config.limits, turns: 3 } },
      one.provider,
    ),
  ).rejects.toThrow('turn-limit');
  expect(one.wire).not.toHaveBeenCalled();
  one.wire.mockImplementationOnce(
    async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              model: pin.model,
              status: 'completed',
              usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: '{"children":[{"recipe":"inspect","brief":"check"}],"waitFor":1}',
                    },
                  ],
                },
              ],
            },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  await host().tickController(cp.run, config, one.provider);
  const pod = String(f.db.prepare('SELECT pod_id FROM managed_pods').pluck().get());
  await f.service().runtime.stop(pod);
  f.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(pod);
  await f.service().enforceExpiry();
  const rebound = setup(),
    original = rebound.accounts.get.getMockImplementation()!;
  let account = 'different';
  rebound.accounts.get.mockImplementation((id) => {
    const out = original(id);
    out.credentials.authJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'another-token', account_id: account },
    });
    return out;
  });
  await expect(host().tickController(cp.run, config, rebound.provider)).rejects.toThrow('not-sent');
  expect(rebound.wire).not.toHaveBeenCalled();
  account = 'fixture';
  rebound.wire.mockRejectedValueOnce(new Error('lost response'));
  await expect(host().tickController(cp.run, config, rebound.provider)).rejects.toThrow(
    'no-response',
  );
  const last = setup();
  await expect(host().tickController(cp.run, config, last.provider)).rejects.toThrow(
    'request-uncertain',
  );
  expect(last.wire).not.toHaveBeenCalled();
  expect(
    f.db.prepare('SELECT status FROM orchestration_controller_turns ORDER BY rowid').pluck().all(),
  ).toEqual(['decided', 'reserved']);
});
it('does not substitute another account, duration, budget mode or legacy cap', async () => {
  for (const override of [
    { accountId: 'other' },
    { timeoutMs: 31000 },
    { budgetMode: 'tokens' },
    { fallback: 'another' },
  ])
    expect(inspectionCodexPin.safeParse({ ...pin, ...override }).success).toBe(false);
  const x = setup();
  await expect(
    x.provider.requestTimeTurn({ ...body, max_tokens: 512 }, x.reserve, 'x'),
  ).rejects.toThrow();
  expect(x.accounts.get).not.toHaveBeenCalled();
  expect(x.wire).not.toHaveBeenCalled();
});

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { expect, it, vi } from 'vitest';
import { resign } from '../test-utils/managed-fixture.js';
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
function completed(text: string) {
  const response = {
    model: pin.model,
    status: 'completed',
    usage: { input_tokens: 199, output_tokens: 571, total_tokens: 770 },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
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
    return completed('{"children":[],"waitFor":null}');
  });
  const provider = bindInspectionCodex(pin, accounts, health, { warn } as unknown as Logger, wire);
  return {
    provider,
    wire,
    reserve,
    accounts,
    warn,
    call: () => provider.requestTimeTurn(body, reserve, `sha256:${'a'.repeat(64)}`),
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
  // Do not silently drop the only verified evidence, or change immutable metadata to fit.
  const context = {
    phase: 'results',
    mission: 'x'.repeat(8192),
    results: [{ finding: { status: 'excerpt', text: '🧭', truncated: false } }],
  };
  await expect(
    x.provider.requestTimeTurn(
      { ...body, messages: [{ role: 'user', content: JSON.stringify(context) }] },
      x.reserve,
      'x',
    ),
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
  one.wire.mockResolvedValueOnce(
    completed('{"children":[{"recipe":"inspect","brief":"check"}],"waitFor":1}'),
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
it.each([
  'plain',
  'escaped',
])('sends four 2 KiB %s verified reports with their admitted recipes after restart', async (mode) => {
  const { cp, f, host, request } = await setupOrchestrationRun(12, 4);
  const cases = new Map([
    ['maple', 'final row omitted'],
    ['iris', 'no defect'],
    ['fir', 'header mismatch'],
    ['cedar', 'worker claims to be IRIS'],
  ]);
  const catalog = Object.fromEntries(
    [...cases.keys()].map((recipe) => {
      const template = structuredClone(request);
      template.task.objective = `Inspect ${recipe}`;
      template.outputs.artifacts.mode = 'required';
      template.outputs.artifacts.requiredPaths = ['report.md'];
      return [recipe, resign(template)];
    }),
  );
  await host().ledger.kickoff(cp, catalog);
  const config = {
    mission: 'Choose the case whose final row is missing.',
    recipes: Object.fromEntries([...cases.keys()].map((k) => [k, `@${k}`])),
    routeId: 'inspection-codex-v1',
    findings: 'required-case-report/v1' as const,
    limits: { turns: 2, workers: 5, outputTokens: 'request-time-30s' as const },
  };
  const kickoff = setup();
  const decision = {
    children: [...cases.keys()].reverse().map((recipe) => ({ recipe, brief: 'inspect' })),
    waitFor: 4,
  };
  kickoff.wire.mockResolvedValueOnce(completed(JSON.stringify(decision)));
  await host().tickController(cp.run, config, kickoff.provider);
  const rows = f.db
    .prepare(
      `SELECT pod_id,json_extract(request_json,'$.task.objective') AS objective FROM managed_pods`,
    )
    .all() as { pod_id: string; objective: string }[];
  expect(rows).toHaveLength(4);
  const reports = new Map(
    rows.map(({ pod_id, objective }) => {
      const summary = cases.get(objective.slice('Inspect '.length, objective.indexOf('\n')));
      if (!summary) throw new Error('unexpected case template');
      const fill = mode === 'plain' ? 'x' : '🧭"\\\n';
      const prefix = `${mode === 'plain' ? '' : ' '.repeat(700)}${summary} `;
      const tailBytes = 2048 - Buffer.byteLength(prefix);
      const text =
        prefix +
        fill.repeat(Math.floor(tailBytes / Buffer.byteLength(fill))) +
        'x'.repeat(tailBytes % Buffer.byteLength(fill));
      return [pod_id, text];
    }),
  );
  f.runtime.observe = async () => ({ state: 'stopped', exitCode: 0, consumedTokens: 0 });
  f.runtime.extractOutput = async (id, dest) => {
    await mkdir(dest, { recursive: true });
    const report = reports.get(id);
    if (!report) throw new Error('unknown report');
    expect(Buffer.byteLength(report)).toBe(2048);
    await writeFile(path.join(dest, 'report.md'), report);
  };
  await f.service().enforceExpiry();
  await f.service().artifactPipeline?.tick();
  f.restart();
  const results = setup();
  const tick = () => host().tickController(cp.run, config, results.provider);
  // A different known template in a damaged kickoff record cannot label an admitted pod.
  const replace = (raw: string) =>
    f.db.prepare('UPDATE orchestration_controller_turns SET decision_json=?').run(raw);
  const original = f.db
    .prepare('SELECT decision_json FROM orchestration_controller_turns')
    .pluck()
    .get() as string;
  replace(
    JSON.stringify({
      ...decision,
      children: decision.children.map((c) => ({ ...c, recipe: 'iris' })),
    }),
  );
  await expect(tick()).rejects.toThrow('controller-case-binding');
  expect(results.wire).not.toHaveBeenCalled();
  replace(original);
  results.wire.mockImplementationOnce(async (_url, init) => {
    const wire = String(init?.body);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(8192);
    const { results: selected } = JSON.parse(JSON.parse(wire).input[0].content[0].text) as {
      results: { recipe: string; finding: { text: string; truncated: boolean } }[];
    };
    expect(selected.map((r) => r.recipe).sort()).toEqual([...cases.keys()].sort());
    for (const { recipe, finding } of selected) {
      expect(finding.truncated).toBe(true);
      const summary = cases.get(recipe);
      if (!summary) throw new Error('unrecognized recipe on wire');
      expect(finding.text.startsWith(summary)).toBe(true);
      expect(finding.text).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    const recipe = selected.find((r) => r.finding.text.startsWith('final row omitted'))?.recipe;
    return completed(
      JSON.stringify({ children: [{ recipe, brief: 'check the final row' }], waitFor: null }),
    );
  });
  await tick();
  expect(results.wire).toHaveBeenCalledOnce();
  expect(
    f.db
      .prepare(
        `SELECT json_extract(request_json,'$.task.objective') FROM orchestration_continuations ORDER BY rowid DESC LIMIT 1`,
      )
      .pluck()
      .get(),
  ).toBe('Inspect maple\n\nFollow-up task:\ncheck the final row');
  expect(
    f.db.prepare('SELECT status FROM orchestration_controller_turns ORDER BY rowid').pluck().all(),
  ).toEqual(['decided', 'decided']);
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

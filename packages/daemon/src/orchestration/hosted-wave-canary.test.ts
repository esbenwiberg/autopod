import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { ProviderAccountHealthStore } from '../provider-accounts/provider-account-health.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { bindCanaryProfile } from './canary-profile.js';
import { bindHostedControllerProfile } from './hosted-controller-profile.js';
import { runHostedWaveCanary } from './hosted-wave-canary.js';

const profile = { name: 'repofit', revision: 2, payload: { aiId: 'ai-2aa5da9e201c0adf52150c71' } };
const ai = {
  revision: 8,
  payload: {
    main: { runtime: 'claude', model: 'claude-sonnet-5-5', providerAccountId: 'anth-pro' },
  },
};
function stores() {
  const config = { get: vi.fn((kind: string) => structuredClone(kind === 'ai' ? ai : profile)) };
  const accounts = {
    get: vi.fn(() => ({
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'fixture-not-real' },
    })),
  };
  const health = { current: vi.fn(() => ({ state: 'unknown' })) };
  const bind = () =>
    bindCanaryProfile(
      config as unknown as ConfigurationStore,
      accounts as unknown as ProviderAccountStore,
      health as unknown as ProviderAccountHealthStore,
      pino({ level: 'silent' }),
    );
  return { config, accounts, health, bind };
}
afterEach(() => vi.unstubAllGlobals());
it('rejects changed main route and an unhealthy account without reading credentials', () => {
  const s = stores();
  s.config.get.mockImplementation((k) => (k === 'ai' ? { ...ai, revision: 9 } : profile));
  expect(s.bind).toThrow('route-changed');
  expect(s.accounts.get).not.toHaveBeenCalled();
  const t = stores();
  t.health.current.mockReturnValue({ state: 'auth_revoked' });
  expect(t.bind).toThrow('unavailable');
  expect(t.accounts.get).not.toHaveBeenCalled();
});
it.each([
  'revoked',
  'oversized',
  'missing-credential',
  'lost-wire',
] as const)('keeps host recovery available and rejects %s before the controller reservation', async (mode) => {
  const { f, cp, request, host } = await setupOrchestrationRun(6, 1);
  const s = stores();
  if (mode === 'revoked') s.health.current.mockReturnValue({ state: 'auth_revoked' });
  const provider = bindHostedControllerProfile(
    {
      profileId: 'p',
      profileName: 'repofit',
      profileRevision: 2,
      aiId: profile.payload.aiId,
      aiRevision: 8,
      model: ai.payload.main.model,
      accountId: 'anth-pro',
    },
    s.config as unknown as ConfigurationStore,
    s.accounts as unknown as ProviderAccountStore,
    s.health as unknown as ProviderAccountHealthStore,
    pino({ level: 'silent' }),
  );
  if (mode === 'missing-credential')
    s.accounts.get.mockImplementation(() => ({
      provider: 'max',
      credentials: { provider: 'max', oauthToken: '' },
    }));
  const owner = host();
  await owner.ledger.kickoff(cp, { inspect: request });
  const wire = vi.fn(() => {
    throw new Error('unexpected external request');
  });
  vi.stubGlobal('fetch', wire);
  await expect(
    owner.tickController(
      cp.run,
      {
        mission: mode === 'oversized' ? '漢'.repeat(4000) : 'Inspect',
        routeId: 'hosted-main',
        recipes: { inspect: '@inspect' },
      },
      provider,
    ),
  ).rejects.toThrow();
  expect(f.db.prepare('SELECT count(*) FROM orchestration_controller_turns').pluck().get()).toBe(
    mode === 'lost-wire' ? 1 : 0,
  );
  expect(s.accounts.get).toHaveBeenCalledTimes(
    mode === 'missing-credential' || mode === 'lost-wire' ? 1 : 0,
  );
  expect(wire).toHaveBeenCalledTimes(mode === 'lost-wire' ? 1 : 0);
  owner.ledger.cancel(cp.run);
  expect(f.db.prepare('SELECT canceled FROM orchestration_runs').pluck().get()).toBe(1);
});
it('rejects an oversized result and reserves at the last boundary for an exact 8 KiB result', async () => {
  const s = stores(),
    p = s.bind(),
    reserve = vi.fn();
  const msg = (phase: string, n = 0) => ({
    model: p.model,
    max_tokens: 512,
    messages: [
      {
        role: 'user' as const,
        content: JSON.stringify({ phase, report: '\\'.repeat(0) + 'x'.repeat(n) }),
      },
    ],
  });
  const wire = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(reserve).toHaveBeenCalledTimes(wire.mock.calls.length);
    return new Response(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: p.model,
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', wire);
  const send = (body: ReturnType<typeof msg>) =>
    p.atControllerSend(reserve, () => p.client.messages.create(body, { maxRetries: 0 }));
  await send(msg('kickoff'));
  const room = 8192 - Buffer.byteLength(JSON.stringify(msg('results')));
  await expect(send(msg('results', room + 1))).rejects.toThrow();
  expect(reserve).toHaveBeenCalledTimes(1);
  await send(msg('results', room));
  expect(Buffer.byteLength(String(wire.mock.calls[1]?.[1]?.body))).toBe(8192);
  expect(reserve).toHaveBeenCalledTimes(2);
});
it('reserves the wire phase on a lost response and does not follow a redirect or retry', async () => {
  const wire = vi.fn(async () => {
    throw new Error('fixture-lost');
  });
  vi.stubGlobal('fetch', wire);
  const { client, model } = stores().bind();
  const send = () =>
    client.messages.create(
      {
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: JSON.stringify({ phase: 'kickoff' }) }],
      },
      { maxRetries: 0 },
    );
  await expect(send()).rejects.toThrow();
  await expect(send()).rejects.toThrow();
  expect(wire).toHaveBeenCalledTimes(1);
  expect(wire).toHaveBeenCalledWith(
    'https://api.anthropic.com/v1/messages',
    expect.objectContaining({ redirect: 'error' }),
  );
});
it.skipIf(!process.env.AUTOPOD_WAVE_DOCKER_IMAGE)(
  'exercises the daemon-owned two-turn path against real Docker and a captured SDK transport',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canary-owner-'));
    const routes: string[] = [];
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          expect(url).toBe('https://api.anthropic.com/v1/messages');
          const body = JSON.parse(init.body);
          expect(body.max_tokens).toBe(512);
          expect(body.tools).toBeUndefined();
          const ctx = JSON.parse(body.messages[0].content);
          routes.push(ctx.phase);
          expect(JSON.stringify(ctx)).not.toContain('fixture-not-real');
          const children =
            ctx.phase === 'kickoff'
              ? Array.from({ length: 6 }, (_, i) => ({ recipe: 'inspect', brief: `Check ${i}` }))
              : ctx.results.flatMap((r: { finding: { text: string } }) =>
                  r.finding.text.includes('no defect')
                    ? []
                    : [{ recipe: 'inspect', brief: `Investigate ${r.finding.text.trim()}` }],
                );
          return new Response(
            JSON.stringify({
              id: 'fixture',
              model: body.model,
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ children, waitFor: routes.length === 1 ? 3 : null }),
                },
              ],
              usage: { input_tokens: 120, output_tokens: 80 },
              stop_reason: 'end_turn',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const databasePath = path.join(root, 'owner.db');
      await writeFile(databasePath, 'fixture');
      const alias = path.join(root, 'same-owner.db');
      await symlink(databasePath, alias);
      const input = {
        databasePath,
        socket: process.env.AUTOPOD_MANAGED_DOCKER_SOCKET!,
        image: process.env.AUTOPOD_WAVE_DOCKER_IMAGE!,
        migrations: path.resolve(import.meta.dirname, '../db/migrations'),
      };
      expect(await runHostedWaveCanary(input, stores().bind())).toEqual({
        calls: 2,
        workers: 8,
        originalSurvivors: 3,
        stopped: 5,
      });
      await expect(
        runHostedWaveCanary({ ...input, databasePath: alias }, stores().bind()),
      ).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(routes).toEqual(['kickoff', 'results']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

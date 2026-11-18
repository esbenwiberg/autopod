import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { ProviderAccountHealthStore } from '../provider-accounts/provider-account-health.js';
import { bindCanaryProfile } from './canary-profile.js';
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
      const input = {
        state: path.join(root, 'once'),
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
      await expect(runHostedWaveCanary(input, stores().bind())).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(routes).toEqual(['kickoff', 'results']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

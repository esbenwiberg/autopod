import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createFrozenScanJudge } from './scan-judge.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(
    class {
      messages = { create: request };
    },
  ),
}));
const logger = pino({ level: 'silent' });
beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({
    content: [{ type: 'text', text: 'Inspect this finding.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 3 },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(provider: 'anthropic' | 'max' = 'anthropic') {
  const db = createTestDb();
  const accounts = createProviderAccountStore(db);
  accounts.create({
    id: 'account',
    name: 'Selected scan account',
    provider,
    credentials:
      provider === 'anthropic'
        ? { provider, apiKey: 'synthetic-selected-key' }
        : { provider, oauthToken: 'synthetic-selected-token' },
  });
  const { services } = createTestConfiguration(db);
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
  const config = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Collect scan evidence' },
    services,
  );
  return { db, accounts, config };
}

it.each(['anthropic', 'max'] as const)(
  'uses only the selected %s account and retains its usage identity',
  async (provider) => {
    const f = await fixture(provider);
    try {
      vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-ambient-key');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-ambient-token');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.invalid');
      const allowed = vi.fn(async () => {});
      const result = await createFrozenScanJudge(f.config, f.accounts, logger, allowed)('Evidence');
      expect(Anthropic).toHaveBeenCalledWith({
        apiKey: provider === 'anthropic' ? 'synthetic-selected-key' : null,
        authToken: provider === 'max' ? 'synthetic-selected-token' : null,
        baseURL: 'https://api.anthropic.com',
        ...(provider === 'max' ? { defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } } : {}),
      });
      expect(result).toMatchObject({
        status: 'complete',
        usage: { providerAccountId: 'account', provider, inputTokens: 10, outputTokens: 3 },
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[0]).not.toHaveProperty('tools');
      expect(allowed).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  },
);

it('rechecks account revocation after collection and before any paid request', async () => {
  const f = await fixture();
  try {
    const judge = createFrozenScanJudge(f.config, f.accounts, logger, async () => {});
    f.accounts.updateCredentials('account', null);
    await expect(judge('Evidence')).rejects.toThrow('not authenticated');
    expect(Anthropic).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('bounds a stalled policy check without dispatching when it eventually returns', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let release: (() => void) | undefined;
    const judge = createFrozenScanJudge(
      f.config,
      f.accounts,
      logger,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = expect(judge('Evidence')).rejects.toThrow('deadline exhausted');
    await vi.advanceTimersByTimeAsync(15001);
    await pending;
    release?.();
    await Promise.resolve();
    expect(Anthropic).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

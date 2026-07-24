import type { Profile, ProviderAccount } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { redactProviderAccountSecrets } from '../api/provider-account-redaction.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { buildProviderEnv } from './env-builder.js';

const logger = pino({ level: 'silent' });
const rawKey = 'fixture-raw-model-provider-key';

function makeProfile(): Profile {
  return {
    name: 'generic-pi',
    repoUrl: 'https://github.com/org/repo',
    defaultRuntime: 'pi',
    modelProvider: 'pi',
    providerAccountId: 'zen-account',
  } as Profile;
}

function makeAccount(): ProviderAccount {
  return {
    id: 'zen-account',
    name: 'Zen account',
    provider: 'opencode-zen',
    credentials: {
      provider: 'api-key',
      providerId: 'opencode-zen',
      apiKey: rawKey,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAuthenticatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
  };
}

describe('generic API-key Pi environment', () => {
  it('places the literal key only in secretFiles and uses a trusted auth command reference', async () => {
    const account = makeAccount();
    const providerAccountStore = {
      get: vi.fn(() => account),
      touchLastUsed: vi.fn(),
    } as unknown as ProviderAccountStore;

    const result = await buildProviderEnv(makeProfile(), 'pod-1', logger, {
      runtime: 'pi',
      providerAccountStore,
    });

    expect(result.secretFiles).toEqual([
      { path: '/run/autopod/model-provider-key', content: rawKey },
    ]);
    expect(result.env).toMatchObject({ PI_CODING_AGENT_DIR: '/home/autopod/.pi/agent' });
    expect(Object.values(result.env)).not.toContain(rawKey);

    const authFile = result.containerFiles.find(
      (file) => file.path === '/home/autopod/.pi/agent/auth.json',
    );
    expect(JSON.parse(authFile?.content ?? '{}')).toEqual({
      opencode: {
        type: 'api_key',
        key: '!cat /run/autopod/model-provider-key',
      },
    });
    expect(JSON.stringify(result.containerFiles)).not.toContain(rawKey);
    expect(result.requiresPostExecPersistence).toBe(false);
    expect(result.requiresPiAuthJsonPersistence).toBe(false);

    // These are every spawn-facing fields produced by the provider builder:
    // env, ordinary files, secret files, persistence flags, and credential owner.
    const observableWithoutSecretFileContents = {
      ...result,
      secretFiles: result.secretFiles.map(({ path }) => ({ path })),
    };
    expect(JSON.stringify(observableWithoutSecretFileContents)).not.toContain(rawKey);

    const publicAccount = redactProviderAccountSecrets(account);
    expect(publicAccount.credentials).toEqual({
      provider: 'api-key',
      providerId: 'opencode-zen',
    });
    expect(JSON.stringify(publicAccount)).not.toContain(rawKey);
  });
});

import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProviderEnv } from './env-builder.js';

const logger = pino({ level: 'silent' });

/** Minimal profile stub with provider fields. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
    repoUrl: 'https://github.com/test/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    executionTarget: 'local',
    customInstructions: null,
    escalation: {
      askHuman: true,
      askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    },
    extends: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    mcpServers: [],
    claudeMdSections: [],
    skills: [],
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr',
    modelProvider: 'anthropic',
    providerCredentials: null,
    testCommand: null,
    prProvider: 'github',
    adoPat: null,
    privateRegistries: [],
    registryPat: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Profile;
}

describe('buildProviderEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('anthropic provider (default)', () => {
    it('uses ANTHROPIC_API_KEY from daemon env when no provider is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
      const profile = makeProfile();

      const result = await buildProviderEnv(profile, 'session-1', logger);

      expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-test123');
      expect(result.containerFiles).toHaveLength(0);
      expect(result.requiresPostExecPersistence).toBe(false);
    });

    it('returns empty env when no API key is set', async () => {
      process.env.ANTHROPIC_API_KEY = undefined;
      const profile = makeProfile();

      const result = await buildProviderEnv(profile, 'session-1', logger);

      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.containerFiles).toHaveLength(0);
    });

    it('handles explicit anthropic modelProvider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-explicit';
      const profile = makeProfile({ modelProvider: 'anthropic' });

      const result = await buildProviderEnv(profile, 'session-1', logger);

      expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-explicit');
    });
  });

  describe('max provider', () => {
    it('builds credentials file and sets HOME', async () => {
      const profile = makeProfile({
        modelProvider: 'max',
        providerCredentials: {
          provider: 'max',
          accessToken: 'access-123',
          refreshToken: 'refresh-456',
          // Far future — no refresh needed
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      });

      const result = await buildProviderEnv(profile, 'session-1', logger);

      // Should NOT have ANTHROPIC_API_KEY (forces OAuth path)
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      // Should NOT override HOME — credentials go to /home/autopod directly
      expect(result.env.HOME).toBeUndefined();
      // Should write credentials file
      expect(result.containerFiles).toHaveLength(2); // .credentials.json + config.json
      expect(result.requiresPostExecPersistence).toBe(true);

      const credsFile = result.containerFiles.find((f) => f.path.includes('.credentials.json'));
      expect(credsFile).toBeDefined();
      const parsed = JSON.parse(credsFile?.content ?? '{}');
      expect(parsed.claudeAiOauth.accessToken).toBe('access-123');
      expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-456');
    });

    it('throws when modelProvider is max but credentials are missing', async () => {
      const profile = makeProfile({
        modelProvider: 'max',
        providerCredentials: null,
      });

      await expect(buildProviderEnv(profile, 'session-1', logger)).rejects.toThrow(
        'missing or mismatched providerCredentials',
      );
    });

    it('throws when modelProvider is max but credentials have wrong provider type', async () => {
      const profile = makeProfile({
        modelProvider: 'max',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://example.com',
          projectId: 'proj-1',
        },
      });

      await expect(buildProviderEnv(profile, 'session-1', logger)).rejects.toThrow(
        'missing or mismatched providerCredentials',
      );
    });
  });

  describe('foundry provider', () => {
    it('sets foundry env vars', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://foundry.azure.com/v1',
          projectId: 'my-project',
          apiKey: 'foundry-key-123',
        },
      });

      const result = await buildProviderEnv(profile, 'session-1', logger);

      expect(result.env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://foundry.azure.com/v1');
      expect(result.env.CLAUDE_FOUNDRY_PROJECT).toBe('my-project');
      expect(result.env.ANTHROPIC_API_KEY).toBe('foundry-key-123');
      expect(result.containerFiles).toHaveLength(0);
      expect(result.requiresPostExecPersistence).toBe(false);
    });

    it('omits API key when using managed identity', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://foundry.azure.com/v1',
          projectId: 'my-project',
          // No apiKey — using managed identity
        },
      });

      const result = await buildProviderEnv(profile, 'session-1', logger);

      expect(result.env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('throws when credentials mismatch provider', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: null,
      });

      await expect(buildProviderEnv(profile, 'session-1', logger)).rejects.toThrow(
        'missing or mismatched providerCredentials',
      );
    });
  });
});

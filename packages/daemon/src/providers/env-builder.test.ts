import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAzureTokenCache } from './azure-token.js';
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
      advisor: { enabled: false },
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
    it('writes API key to a secret file (not in env) when ANTHROPIC_API_KEY is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
      const profile = makeProfile();

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      // Raw key must NOT be in env — only the file pointer
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY_FILE).toBe('/run/autopod/anthropic-api-key');
      // Secret file must hold the raw key
      expect(result.secretFiles).toHaveLength(1);
      expect(result.secretFiles[0]?.content).toBe('sk-ant-test123');
      expect(result.containerFiles).toHaveLength(2); // .claude.json + settings.json
      expect(result.requiresPostExecPersistence).toBe(false);
    });

    it('returns empty secretFiles when no API key is set', async () => {
      process.env.ANTHROPIC_API_KEY = undefined;
      const profile = makeProfile();

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY_FILE).toBeUndefined();
      expect(result.secretFiles).toHaveLength(0);
      expect(result.containerFiles).toHaveLength(2); // .claude.json + settings.json
    });

    it('handles explicit anthropic modelProvider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-explicit';
      const profile = makeProfile({ modelProvider: 'anthropic' });

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      expect(result.env.ANTHROPIC_API_KEY_FILE).toBe('/run/autopod/anthropic-api-key');
      expect(result.secretFiles[0]?.content).toBe('sk-ant-explicit');
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

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      // Should NOT have ANTHROPIC_API_KEY (forces OAuth path)
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      // Should NOT override HOME — credentials go to /home/autopod directly
      expect(result.env.HOME).toBeUndefined();
      // Should write credentials + .claude.json + settings.json
      expect(result.containerFiles).toHaveLength(3); // .credentials.json + .claude.json + settings.json
      expect(result.requiresPostExecPersistence).toBe(true);

      const credsFile = result.containerFiles.find((f) => f.path.includes('.credentials.json'));
      expect(credsFile).toBeDefined();
      const parsed = JSON.parse(credsFile?.content ?? '{}');
      expect(parsed.claudeAiOauth.accessToken).toBe('access-123');
      expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-456');

      // .claude.json should skip onboarding + pre-accept workspace trust
      const claudeJson = result.containerFiles.find((f) => f.path.endsWith('.claude.json'));
      expect(claudeJson).toBeDefined();
      const claudeParsed = JSON.parse(claudeJson?.content ?? '{}');
      expect(claudeParsed.hasCompletedOnboarding).toBe(true);
      expect(claudeParsed.hasAcknowledgedDisclaimer).toBe(true);
      expect(claudeParsed.projects['/workspace'].hasTrustDialogAccepted).toBe(true);

      // settings.json should set dark theme
      const settingsJson = result.containerFiles.find((f) => f.path.endsWith('settings.json'));
      expect(settingsJson).toBeDefined();
      expect(JSON.parse(settingsJson?.content ?? '{}')).toEqual({
        theme: 'dark',
        autoUpdaterStatus: 'disabled',
        env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
      });
    });

    it('throws when modelProvider is max but credentials are missing', async () => {
      const profile = makeProfile({
        modelProvider: 'max',
        providerCredentials: null,
      });

      await expect(buildProviderEnv(profile, 'pod-1', logger)).rejects.toThrow(
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

      await expect(buildProviderEnv(profile, 'pod-1', logger)).rejects.toThrow(
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

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      expect(result.env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://foundry.azure.com/v1');
      expect(result.env.CLAUDE_FOUNDRY_PROJECT).toBe('my-project');
      // Raw key must NOT be in env — written to a secret file
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY_FILE).toBe('/run/autopod/foundry-api-key');
      expect(result.secretFiles[0]?.content).toBe('foundry-key-123');
      expect(result.containerFiles).toHaveLength(2); // .claude.json + settings.json
      expect(result.requiresPostExecPersistence).toBe(false);
    });

    it('throws when credentials mismatch provider', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: null,
      });

      await expect(buildProviderEnv(profile, 'pod-1', logger)).rejects.toThrow(
        'missing or mismatched providerCredentials',
      );
    });
  });

  describe('foundry provider — managed-identity (no static apiKey)', () => {
    beforeEach(() => {
      clearAzureTokenCache();
      vi.resetModules();
      vi.doMock('@azure/identity', () => ({
        DefaultAzureCredential: vi.fn().mockImplementation(() => ({
          getToken: vi.fn().mockResolvedValue({
            token: 'entra-bearer-xyz',
            expiresOnTimestamp: Date.now() + 3600_000,
          }),
        })),
      }));
    });

    afterEach(() => {
      vi.doUnmock('@azure/identity');
    });

    it('acquires an Entra bearer token and writes it to the secret file', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://foundry.azure.com/v1',
          projectId: 'my-project',
          // No apiKey — should trigger getAzureToken
        },
      });

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      expect(result.env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
      expect(result.env.ANTHROPIC_BASE_URL).toBe('https://foundry.azure.com/v1');
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY_FILE).toBe('/run/autopod/foundry-api-key');
      expect(result.secretFiles).toHaveLength(1);
      expect(result.secretFiles[0]?.content).toBe('entra-bearer-xyz');
    });
  });

  describe('foundry provider — openai surface', () => {
    it('routes through OpenAI env vars instead of Anthropic when apiSurface=openai', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://my-foundry.openai.azure.com',
          projectId: 'gpt-deployment',
          apiKey: 'foundry-openai-key',
          apiSurface: 'openai',
          apiVersion: '2024-12-01-preview',
        },
      });

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      // Anthropic env vars must NOT be set on the openai surface
      expect(result.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
      expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY_FILE).toBeUndefined();

      // OpenAI/Azure-OpenAI env vars set instead
      expect(result.env.OPENAI_BASE_URL).toBe('https://my-foundry.openai.azure.com');
      expect(result.env.AZURE_OPENAI_ENDPOINT).toBe('https://my-foundry.openai.azure.com');
      expect(result.env.OPENAI_API_KEY_FILE).toBe('/run/autopod/foundry-openai-key');
      expect(result.env.AZURE_OPENAI_API_KEY_FILE).toBe('/run/autopod/foundry-openai-key');
      expect(result.env.OPENAI_API_VERSION).toBe('2024-12-01-preview');
      expect(result.env.AZURE_OPENAI_API_VERSION).toBe('2024-12-01-preview');
      expect(result.env.CLAUDE_FOUNDRY_PROJECT).toBe('gpt-deployment');

      expect(result.secretFiles).toHaveLength(1);
      expect(result.secretFiles[0]?.path).toBe('/run/autopod/foundry-openai-key');
      expect(result.secretFiles[0]?.content).toBe('foundry-openai-key');
    });

    it('omits api-version env vars when not configured', async () => {
      const profile = makeProfile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://my-foundry.openai.azure.com',
          projectId: 'gpt-deployment',
          apiKey: 'k',
          apiSurface: 'openai',
        },
      });

      const result = await buildProviderEnv(profile, 'pod-1', logger);

      expect(result.env.OPENAI_API_VERSION).toBeUndefined();
      expect(result.env.AZURE_OPENAI_API_VERSION).toBeUndefined();
    });
  });
});

import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { generateDockerfile, getBaseImage, getInstallCommand } from './dockerfile-generator.js';

function mockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-app',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/',
    healthTimeout: 120,
    validationPages: [],
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
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getBaseImage', () => {
  it.each([
    ['node22', 'autopod-node22:latest'],
    ['node22-pw', 'autopod-node22-pw:latest'],
    ['dotnet9', 'autopod-dotnet9:latest'],
    ['python312', 'autopod-python312:latest'],
    ['custom', 'autopod-node22:latest'],
  ] as const)('maps %s → %s', (template, expected) => {
    expect(getBaseImage(template)).toBe(expected);
  });
});

describe('getInstallCommand', () => {
  it('detects pnpm', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'pnpm run build' }))).toContain(
      'pnpm install',
    );
  });

  it('detects yarn', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'yarn build' }))).toContain(
      'yarn install',
    );
  });

  it('detects dotnet', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'dotnet build' }))).toBe('dotnet restore');
  });

  it('detects pip', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'pip install -e .' }))).toBe(
      'pip install -r requirements.txt',
    );
  });

  it('defaults to npm ci', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'npm run build' }))).toBe('npm ci');
  });
});

describe('generateDockerfile', () => {
  it('generates Dockerfile for node22-pw template', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'node22-pw' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-node22-pw:latest');
    expect(df).toContain('npm ci');
    expect(df).toContain('npm run build || true');
    expect(df).toContain('USER autopod');
  });

  it('generates Dockerfile for pnpm project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ buildCommand: 'pnpm run build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('corepack enable pnpm');
    expect(df).toContain('pnpm install --frozen-lockfile');
  });

  it('generates Dockerfile for dotnet project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'dotnet9', buildCommand: 'dotnet build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet9:latest');
    expect(df).toContain('dotnet restore');
  });

  it('generates Dockerfile for python project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'python312', buildCommand: 'pip install -e .' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-python312:latest');
    expect(df).toContain('pip install -r requirements.txt');
  });

  it('includes PAT-based git clone for private repos', () => {
    const df = generateDockerfile({
      profile: mockProfile({ repoUrl: 'https://github.com/private/repo' }),
      gitCredentials: 'pat',
    });
    expect(df).toContain('ARG GIT_PAT');
    expect(df).toContain('x-access-token:${GIT_PAT}@');
    expect(df).toContain('git remote set-url origin');
  });

  it('does not include PAT args for public repos', () => {
    const df = generateDockerfile({
      profile: mockProfile(),
      gitCredentials: 'none',
    });
    expect(df).not.toContain('ARG GIT_PAT');
    expect(df).not.toContain('x-access-token');
  });

  it('strips https protocol from repo URL in PAT clone', () => {
    const df = generateDockerfile({
      profile: mockProfile({ repoUrl: 'https://github.com/org/repo' }),
      gitCredentials: 'pat',
    });
    // The repo URL protocol is stripped so the PAT auth URL is correctly formed
    expect(df).toContain('x-access-token:${GIT_PAT}@github.com/org/repo');
    // Should not double-up the protocol (no https://https://)
    expect(df).not.toContain('https://https://');
  });

  it('uses plain git clone for public repos', () => {
    const df = generateDockerfile({
      profile: mockProfile({ repoUrl: 'https://github.com/org/repo' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('RUN git clone --depth 1 https://github.com/org/repo .');
  });

  it('always ends with USER autopod', () => {
    const df = generateDockerfile({
      profile: mockProfile(),
      gitCredentials: 'none',
    });
    const lines = df.split('\n');
    expect(lines[lines.length - 1]).toBe('USER autopod');
  });
});

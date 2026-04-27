import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { generateDockerfile, getBaseImage, getInstallCommand } from './dockerfile-generator.js';

function extractBlock(dockerfile: string, startMarker: string, endMarker: string): string {
  const start = dockerfile.indexOf(startMarker);
  if (start === -1) throw new Error(`startMarker not found: ${startMarker}`);
  const end = dockerfile.indexOf(endMarker, start);
  if (end === -1) throw new Error(`endMarker not found after start: ${endMarker}`);
  return dockerfile.slice(start, end + endMarker.length);
}

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
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr' as const,
    modelProvider: 'anthropic' as const,
    providerCredentials: null,
    testCommand: null,
    prProvider: 'github' as const,
    adoPat: null,
    skills: [],
    privateRegistries: [],
    registryPat: null,
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
    ['dotnet10', 'autopod-dotnet10:latest'],
    ['dotnet10-go', 'autopod-dotnet10-go:latest'],
    ['python312', 'autopod-python312:latest'],
    ['go124', 'autopod-go124:latest'],
    ['go124-pw', 'autopod-go124-pw:latest'],
    ['python-node', 'autopod-python-node:latest'],
    ['custom', 'autopod-node22:latest'],
  ] as const)('maps %s → %s (no digest)', (template, expected) => {
    expect(getBaseImage(template)).toBe(expected);
  });

  it('uses sha256 digest when provided in digest map', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(getBaseImage('node22', { node22: digest })).toBe(`autopod-node22@${digest}`);
  });

  it('falls back to :latest when digest is null', () => {
    expect(getBaseImage('node22', { node22: null })).toBe('autopod-node22:latest');
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
    expect(
      getInstallCommand(mockProfile({ template: 'dotnet10', buildCommand: 'dotnet build' })),
    ).toBe('dotnet restore');
  });

  it('detects mixed dotnet+npm', () => {
    expect(
      getInstallCommand(
        mockProfile({ template: 'dotnet10', buildCommand: 'dotnet build && npm run build' }),
      ),
    ).toBe('dotnet restore && npm ci');
  });

  it('detects mixed dotnet+pnpm', () => {
    expect(
      getInstallCommand(
        mockProfile({ template: 'dotnet10', buildCommand: 'dotnet build && pnpm run build' }),
      ),
    ).toContain('dotnet restore');
  });

  it('treats dotnet10-go like dotnet10 for primary install', () => {
    expect(
      getInstallCommand(mockProfile({ template: 'dotnet10-go', buildCommand: 'dotnet build' })),
    ).toBe('dotnet restore');
  });

  it('mixes dotnet+npm on dotnet10-go', () => {
    expect(
      getInstallCommand(
        mockProfile({
          template: 'dotnet10-go',
          buildCommand: 'dotnet build && npm run build',
        }),
      ),
    ).toBe('dotnet restore && npm ci');
  });

  it('detects pip', () => {
    expect(getInstallCommand(mockProfile({ buildCommand: 'pip install -e .' }))).toBe(
      'pip install -r requirements.txt',
    );
  });

  it('python-node: pip only when no node pkg manager', () => {
    expect(
      getInstallCommand(
        mockProfile({
          template: 'python-node',
          buildCommand: 'pip install -e . && python manage.py collectstatic',
        }),
      ),
    ).toBe('pip install -r requirements.txt');
  });

  it('python-node: pip + npm ci when build uses npm', () => {
    expect(
      getInstallCommand(
        mockProfile({ template: 'python-node', buildCommand: 'pip install -e . && npm run build' }),
      ),
    ).toBe('pip install -r requirements.txt && npm ci');
  });

  it('python-node: pip + pnpm when build uses pnpm', () => {
    expect(
      getInstallCommand(
        mockProfile({
          template: 'python-node',
          buildCommand: 'pip install -e . && pnpm run build',
        }),
      ),
    ).toBe(
      'pip install -r requirements.txt && corepack enable pnpm && pnpm install --frozen-lockfile',
    );
  });

  it('python-node: pip + yarn when build uses yarn', () => {
    expect(
      getInstallCommand(
        mockProfile({ template: 'python-node', buildCommand: 'pip install -e . && yarn build' }),
      ),
    ).toBe(
      'pip install -r requirements.txt && corepack enable yarn && yarn install --frozen-lockfile',
    );
  });

  it('uses go mod download for go124', () => {
    expect(
      getInstallCommand(mockProfile({ template: 'go124', buildCommand: 'go build ./...' })),
    ).toBe('go mod download');
  });

  it('mixes go + pnpm for go124-pw polyglot builds', () => {
    expect(
      getInstallCommand(
        mockProfile({
          template: 'go124-pw',
          buildCommand: 'go build ./... && pnpm --filter portal build',
        }),
      ),
    ).toBe('go mod download && corepack enable pnpm && pnpm install --frozen-lockfile');
  });

  it('falls back to go mod download for go124-pw when build is pure Go', () => {
    expect(
      getInstallCommand(mockProfile({ template: 'go124-pw', buildCommand: 'go build ./...' })),
    ).toBe('go mod download');
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

  it('uses sha256 digest in FROM when imageDigests map is provided', () => {
    const digest = `sha256:${'f'.repeat(64)}`;
    const df = generateDockerfile({
      profile: mockProfile({ template: 'node22' }),
      gitCredentials: 'none',
      imageDigests: { node22: digest },
    });
    expect(df).toContain(`FROM autopod-node22@${digest}`);
    expect(df).not.toContain('autopod-node22:latest');
  });

  it('generates Dockerfile for pnpm project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ buildCommand: 'pnpm run build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('corepack enable pnpm');
    expect(df).toContain('pnpm install --frozen-lockfile');
  });

  it('generates Dockerfile for dotnet9 project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'dotnet9', buildCommand: 'dotnet build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet9:latest');
    expect(df).toContain('dotnet restore');
  });

  it('generates Dockerfile for dotnet10 project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'dotnet10', buildCommand: 'dotnet build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet10:latest');
    expect(df).toContain('dotnet restore');
  });

  it('generates Dockerfile for dotnet10-go project (Dagger-in-Go pipelines)', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'dotnet10-go', buildCommand: 'dotnet build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet10-go:latest');
    expect(df).toContain('dotnet restore');
  });

  it('generates Dockerfile for dotnet10+npm project', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        template: 'dotnet10',
        buildCommand: 'dotnet build && npm run build',
      }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet10:latest');
    expect(df).toContain('dotnet restore && npm ci');
  });

  it('generates Dockerfile for python project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'python312', buildCommand: 'pip install -e .' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-python312:latest');
    expect(df).toContain('pip install -r requirements.txt');
  });

  it('generates Dockerfile for python-node project with both installs', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        template: 'python-node',
        buildCommand: 'pip install -e . && npm run build',
      }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-python-node:latest');
    expect(df).toContain('pip install -r requirements.txt && npm ci');
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

  it('injects npm registry config with REGISTRY_PAT build arg', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        privateRegistries: [
          {
            type: 'npm',
            url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
            scope: '@myorg',
          },
        ],
        registryPat: 'secret',
      }),
      gitCredentials: 'none',
    });
    expect(df).toContain('ARG REGISTRY_PAT');
    expect(df).toContain(
      '@myorg:registry=https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
    );
    expect(df).toContain(':_authToken=$REGISTRY_PAT');
    expect(df).toContain(':always-auth=true');
    // Credentials should be cleaned up
    expect(df).toContain('rm -f /workspace/.npmrc');
  });

  it('injects NuGet registry config via credential provider env var', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        template: 'dotnet10',
        buildCommand: 'dotnet build',
        privateRegistries: [
          {
            type: 'nuget',
            url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/nuget/v3/index.json',
          },
        ],
        registryPat: 'secret',
      }),
      gitCredentials: 'none',
    });
    expect(df).toContain('ARG VSS_NUGET_EXTERNAL_FEED_ENDPOINTS');
    expect(df).toContain(
      'ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS=$VSS_NUGET_EXTERNAL_FEED_ENDPOINTS',
    );
    expect(df).toContain('packageSources');
    expect(df).toContain('myorg-shared');
    // No cleartext credentials in config files
    expect(df).not.toContain('ClearTextPassword');
    expect(df).not.toContain('packageSourceCredentials');
    // NuGet-only should not declare REGISTRY_PAT (that's for npm)
    expect(df).not.toContain('ARG REGISTRY_PAT');
    // packageSourceMapping included so private feeds work with strict source mapping
    expect(df).toContain('packageSourceMapping');
    // Sources-only config cleaned up, env var cleared
    expect(df).toContain('rm -f /workspace/NuGet.config');
    expect(df).toContain('ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS=');
  });

  it('injects both npm and NuGet registries', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        template: 'dotnet10',
        buildCommand: 'dotnet build && npm run build',
        privateRegistries: [
          {
            type: 'npm',
            url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
            scope: '@myorg',
          },
          {
            type: 'nuget',
            url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/nuget/v3/index.json',
          },
        ],
        registryPat: 'secret',
      }),
      gitCredentials: 'none',
    });
    expect(df).toContain('.npmrc');
    expect(df).toContain('NuGet.config');
  });

  it('does not inject registry config when no registries', () => {
    const df = generateDockerfile({
      profile: mockProfile({ privateRegistries: [] }),
      gitCredentials: 'none',
    });
    expect(df).not.toContain('REGISTRY_PAT');
    expect(df).not.toContain('VSS_NUGET_EXTERNAL_FEED_ENDPOINTS');
    expect(df).not.toContain('.npmrc');
    expect(df).not.toContain('NuGet.config');
  });

  it('installs the Dagger CLI via pinned download when version config is provided', () => {
    const daggerCliVersion = {
      version: '0.15.3',
      linuxAmd64Digest: `sha256:${'a'.repeat(64)}`,
    };
    const df = generateDockerfile({
      profile: mockProfile({
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'b'.repeat(64)}`,
            engineVersion: 'v0.15.3',
          },
        },
      }),
      gitCredentials: 'none',
      daggerCliVersion,
    });
    expect(df).toContain('github.com/dagger/dagger/releases/download/v0.15.3');
    expect(df).toContain(`sha256:${'a'.repeat(64)}  /tmp/dagger.tar.gz`);
    expect(df).toContain('sha256sum -c');
    expect(df).toContain('tar -xz -C /usr/local/bin');
    // Must not use the curl-pipe-sh installer
    expect(df).not.toContain('install.sh');
    // Must not leak docker-cli — the pod talks to the engine via TCP, not docker.sock
    expect(df).not.toContain('docker-cli');
    expect(df).not.toContain('docker-ce-cli');
  });

  it('falls back to install.sh when dagger version config is absent', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'v0.12.0',
          },
        },
      }),
      gitCredentials: 'none',
      daggerCliVersion: undefined,
    });
    expect(df).toContain('dl.dagger.io');
    expect(df).toContain('install.sh');
  });

  it('does not install the Dagger CLI when the dagger sidecar is disabled', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        sidecars: {
          dagger: {
            enabled: false,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'v0.12.0',
          },
        },
      }),
      gitCredentials: 'none',
    });
    expect(df).not.toContain('dl.dagger.io');
  });

  it.each(['dotnet9', 'dotnet10', 'dotnet10-go', 'go124', 'go124-pw'] as const)(
    'skips the per-pod Dagger CLI install on %s (pre-installed in base image)',
    (template) => {
      const df = generateDockerfile({
        profile: mockProfile({
          template,
          sidecars: {
            dagger: {
              enabled: true,
              engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
              engineVersion: 'v0.12.0',
            },
          },
        }),
        gitCredentials: 'none',
      });
      expect(df).not.toContain('dl.dagger.io');
    },
  );

  it('snapshot: full Dockerfile with npm + nuget registries and PAT git', () => {
    const df = generateDockerfile({
      profile: mockProfile({
        template: 'dotnet10',
        repoUrl: 'https://github.com/org/full-stack',
        buildCommand: 'dotnet build && npm run build',
        privateRegistries: [
          {
            type: 'npm',
            url: 'https://pkgs.dev.azure.com/contoso/_packaging/libs/npm/registry/',
            scope: '@contoso',
          },
          {
            type: 'nuget',
            url: 'https://pkgs.dev.azure.com/contoso/_packaging/libs/nuget/v3/index.json',
          },
        ],
        registryPat: 'secret',
      }),
      gitCredentials: 'pat',
    });

    // Verify ordering: git clone → registry config → install → build → cleanup → USER
    const lines = df.split('\n');
    const gitCloneIdx = lines.findIndex((l) => l.includes('git clone'));
    const registryArgIdx = lines.findIndex((l) => l.includes('ARG REGISTRY_PAT'));
    const nugetEnvIdx = lines.findIndex((l) => l.includes('ARG VSS_NUGET_EXTERNAL_FEED_ENDPOINTS'));
    const npmrcIdx = lines.findIndex((l) => l.includes('.npmrc'));
    const nugetIdx = lines.findIndex((l) => l.includes('NuGet.config'));
    const installIdx = lines.findIndex((l) => l.includes('Install dependencies'));
    const cleanupIdx = lines.findIndex((l) => l.includes('Remove registry config'));
    const userIdx = lines.findIndex((l) => l === 'USER autopod');

    expect(gitCloneIdx).toBeLessThan(registryArgIdx);
    expect(registryArgIdx).toBeLessThan(npmrcIdx);
    expect(nugetEnvIdx).toBeLessThan(nugetIdx);
    expect(nugetIdx).toBeLessThan(installIdx);
    expect(installIdx).toBeLessThan(cleanupIdx);
    expect(cleanupIdx).toBeLessThan(userIdx);

    // No cleartext credentials in NuGet config
    expect(df).not.toContain('ClearTextPassword');
    // npm credentials cleaned up
    expect(df).toContain('rm -f /workspace/.npmrc /workspace/NuGet.config');
    // NuGet credential provider env cleared
    expect(df).toContain('ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS=');
    // Git credentials are also cleaned up
    expect(df).toContain('git remote set-url origin');
  });

  describe('codeIntelligence install steps', () => {
    it('omits both blocks when codeIntelligence is null', () => {
      const df = generateDockerfile({
        profile: mockProfile({ codeIntelligence: null }),
        gitCredentials: 'none',
      });
      expect(df).not.toContain('serena');
      expect(df).not.toContain('RoslynCodeLens.Mcp');
    });

    it('installs Serena via uv with the canonical PyPI package and verifies the binary', () => {
      const df = generateDockerfile({
        profile: mockProfile({ codeIntelligence: { serena: true } }),
        gitCredentials: 'none',
      });
      expect(df).toContain('uv tool install -p 3.13 serena-agent@latest --prerelease=allow');
      expect(df).toContain('serena --help');
      // Loud failure: the Serena install block must NOT swallow errors silently —
      // that is what hid the entire feature from working for weeks. Scope the
      // assertion to the install block itself (other lines, e.g. agent CLI bulk
      // install + pre-warm build, legitimately use `|| true`).
      const serenaBlock = extractBlock(df, '# Serena —', 'serena --help');
      expect(serenaBlock).not.toContain('|| true');
      expect(serenaBlock).not.toContain('2>/dev/null');
    });

    it('installs RoslynCodeLens.Mcp with the correct CamelCase package id', () => {
      const df = generateDockerfile({
        profile: mockProfile({
          template: 'dotnet9',
          codeIntelligence: { roslynCodeLens: true },
        }),
        gitCredentials: 'none',
      });
      expect(df).toContain('dotnet tool install -g RoslynCodeLens.Mcp');
      expect(df).toContain('roslyn-codelens-mcp --help');
      const roslynBlock = extractBlock(df, '# roslyn-codelens-mcp', 'roslyn-codelens-mcp --help');
      expect(roslynBlock).not.toContain('|| true');
      expect(roslynBlock).not.toContain('2>/dev/null');
    });
  });
});

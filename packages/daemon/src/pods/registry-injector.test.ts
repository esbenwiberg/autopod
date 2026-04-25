import type { PrivateRegistry } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  CREDENTIAL_GUARD_HOOK,
  NPM_RC_PATH,
  NUGET_CONFIG_PATH,
  buildNuGetCredentialEnv,
  buildNuGetSecretFile,
  buildRegistryFiles,
  ensureNuGetCredentialProvider,
  generateNpmrc,
  generateNuGetConfig,
  validateRegistryFiles,
} from './registry-injector.js';

describe('buildRegistryFiles', () => {
  it('returns empty array when no registries', () => {
    expect(buildRegistryFiles([], 'some-pat')).toEqual([]);
  });

  it('returns empty array when no PAT', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
    ];
    expect(buildRegistryFiles(regs, null)).toEqual([]);
  });

  it('generates .npmrc at user-level home path', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(NPM_RC_PATH);
    expect(files[0].content).toContain('my-pat');
  });

  it('generates NuGet.config at user-level home path (sources only, no credentials)', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(NUGET_CONFIG_PATH);
    expect(files[0].content).toContain('packageSources');
    expect(files[0].content).not.toContain('ClearTextPassword');
    expect(files[0].content).not.toContain('my-pat');
  });

  it('generates both files when both types present', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual([NPM_RC_PATH, NUGET_CONFIG_PATH]);
  });
});

describe('generateNpmrc', () => {
  it('generates scoped registry entry', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'npm',
        url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
        scope: '@myorg',
      },
    ];
    const content = generateNpmrc(regs, 'test-pat');
    expect(content).toContain(
      '@myorg:registry=https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
    );
    expect(content).toContain(
      '//pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/:_authToken=test-pat',
    );
    expect(content).toContain(
      '//pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/:always-auth=true',
    );
  });

  it('generates unscoped registry entry (default override)', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/' },
    ];
    const content = generateNpmrc(regs, 'test-pat');
    expect(content).toContain(
      'registry=https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
    );
    expect(content).not.toContain('@');
  });

  it('adds trailing slash to URL if missing', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry' },
    ];
    const content = generateNpmrc(regs, 'test-pat');
    expect(content).toContain(
      'registry=https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
    );
  });

  it('handles multiple npm registries', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'npm',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-a/npm/registry/',
        scope: '@libs',
      },
      {
        type: 'npm',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-b/npm/registry/',
        scope: '@tools',
      },
    ];
    const content = generateNpmrc(regs, 'pat');
    expect(content).toContain('@libs:registry=');
    expect(content).toContain('@tools:registry=');
  });
});

describe('generateNuGetConfig', () => {
  it('generates sources-only NuGet.config XML without credentials', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<configuration>');
    expect(content).toContain('<packageSources>');
    // <clear /> removes default nuget.org — all resolution goes through the private feed
    expect(content).toContain('<clear />');
    // No hardcoded nuget.org — private feed proxies public packages via upstream sources
    expect(content).not.toContain('nuget.org');
    expect(content).toContain('myorg-shared');
    // No credentials — auth handled by credential provider via env var
    expect(content).not.toContain('packageSourceCredentials');
    expect(content).not.toContain('ClearTextPassword');
    expect(content).toContain('</configuration>');
  });

  it('includes packageSourceMapping for each private feed', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('<packageSourceMapping>');
    expect(content).toContain('<packageSource key="myorg-shared">');
    expect(content).toContain('<package pattern="*" />');
    expect(content).toContain('</packageSourceMapping>');
  });

  it('includes packageSourceMapping for multiple feeds', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-a/nuget/v3/index.json',
      },
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-b/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('<packageSource key="org-feed-a">');
    expect(content).toContain('<packageSource key="org-feed-b">');
  });

  it('derives feed name from Azure DevOps URL', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/contoso/_packaging/internal-libs/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('contoso-internal-libs');
  });

  it('handles project-scoped feed URL', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/contoso/MyProject/_packaging/internal-libs/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('contoso-internal-libs');
  });

  it('handles multiple NuGet feeds', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-a/nuget/v3/index.json',
      },
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-b/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('org-feed-a');
    expect(content).toContain('org-feed-b');
  });

  it('prefixes feed name with underscore when org name starts with a digit', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/365projectum/_packaging/shared-libs/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('_365projectum-shared-libs');
  });

  it('produces valid element names for non-ADO URLs with dots', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://nuget.my-company.com/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs);
    expect(content).toContain('nuget.my-company.com-index.json');
  });
});

describe('buildNuGetSecretFile', () => {
  it('returns null when no PAT', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    expect(buildNuGetSecretFile(regs, null)).toBeNull();
  });

  it('returns null when no NuGet registries', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
    ];
    expect(buildNuGetSecretFile(regs, 'my-pat')).toBeNull();
  });

  it('returns secret file with credentials JSON for NuGet registries', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const sf = buildNuGetSecretFile(regs, 'my-pat');
    expect(sf).not.toBeNull();
    expect(sf?.path).toBe('/run/autopod/nuget-endpoints');
    expect(sf?.envFileKey).toBe('VSS_NUGET_EXTERNAL_FEED_ENDPOINTS_FILE');
    const parsed = JSON.parse(sf?.content ?? '{}');
    expect(parsed.endpointCredentials).toHaveLength(1);
    expect(parsed.endpointCredentials[0].endpoint).toBe(
      'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json',
    );
    expect(parsed.endpointCredentials[0].username).toBe('VssSessionToken');
    expect(parsed.endpointCredentials[0].password).toBe('my-pat');
  });

  it('includes multiple NuGet feeds', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-a/nuget/v3/index.json',
      },
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed-b/nuget/v3/index.json',
      },
    ];
    const sf = buildNuGetSecretFile(regs, 'pat');
    const parsed = JSON.parse(sf?.content ?? '{}');
    expect(parsed.endpointCredentials).toHaveLength(2);
  });

  it('ignores npm registries', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const sf = buildNuGetSecretFile(regs, 'pat');
    const parsed = JSON.parse(sf?.content ?? '{}');
    expect(parsed.endpointCredentials).toHaveLength(1);
    expect(parsed.endpointCredentials[0].endpoint).toContain('nuget');
  });
});

describe('buildNuGetCredentialEnv (image-build only)', () => {
  it('returns VSS_NUGET_EXTERNAL_FEED_ENDPOINTS for Docker build args', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const env = buildNuGetCredentialEnv(regs, 'my-pat');
    expect(env).toHaveProperty('VSS_NUGET_EXTERNAL_FEED_ENDPOINTS');
    const parsed = JSON.parse(env.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS ?? '{}');
    expect(parsed.endpointCredentials[0].password).toBe('my-pat');
  });

  it('returns empty object when no PAT', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    expect(buildNuGetCredentialEnv(regs, null)).toEqual({});
  });
});

describe('validateRegistryFiles', () => {
  function mockCm(results: Record<string, { stdout: string; stderr: string; exitCode: number }>) {
    return {
      execInContainer: vi.fn().mockImplementation((_id: string, cmd: string[]) => {
        const cmdStr = cmd.join(' ');
        for (const [key, val] of Object.entries(results)) {
          if (cmdStr.includes(key)) return Promise.resolve(val);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }),
    } as unknown as ContainerManager;
  }

  it('passes when nuget config is valid and auth succeeds', async () => {
    const cm = mockCm({
      'dotnet nuget list': {
        stdout: 'Registered Sources:\n  1. nuget.org',
        stderr: '',
        exitCode: 0,
      },
      'dotnet nuget search': { stdout: 'No results found.', stderr: '', exitCode: 0 },
    });
    const files = [{ path: NUGET_CONFIG_PATH, content: '<valid/>' }];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).resolves.toBeUndefined();
  });

  it('throws when nuget config is invalid', async () => {
    const cm = mockCm({
      'dotnet nuget list': {
        stdout: 'NuGet.Config is not valid XML',
        stderr: '',
        exitCode: 1,
      },
    });
    const files = [{ path: NUGET_CONFIG_PATH, content: 'garbage' }];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).rejects.toThrow(
      /Registry check failed.*NuGet\.Config is invalid/,
    );
  });

  it('throws when nuget auth fails with NU1301', async () => {
    const cm = mockCm({
      'dotnet nuget list': {
        stdout: 'Registered Sources:\n  1. private-feed',
        stderr: '',
        exitCode: 0,
      },
      'dotnet nuget search': {
        stdout:
          'error NU1301: Unable to load the service index for source https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json. Response status code does not indicate success: 401 (Unauthorized).',
        stderr: '',
        exitCode: 1,
      },
    });
    const files = [{ path: NUGET_CONFIG_PATH, content: '<valid/>' }];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).rejects.toThrow(
      /Registry auth failed.*PAT.*Packaging/,
    );
  });

  it('throws when npmrc is invalid', async () => {
    const cm = mockCm({
      'npm config': { stdout: '', stderr: 'Invalid config', exitCode: 1 },
    });
    const files = [{ path: NPM_RC_PATH, content: 'garbage' }];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).rejects.toThrow(
      /Registry check failed.*\.npmrc is invalid/,
    );
  });

  it('validates both files when both present', async () => {
    const cm = mockCm({
      'npm config': { stdout: '', stderr: '', exitCode: 0 },
      'dotnet nuget list': { stdout: 'Sources', stderr: '', exitCode: 0 },
      'dotnet nuget search': { stdout: 'No results found.', stderr: '', exitCode: 0 },
    });
    const files = [
      { path: NPM_RC_PATH, content: 'ok' },
      { path: NUGET_CONFIG_PATH, content: 'ok' },
    ];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).resolves.toBeUndefined();
    // npm config + dotnet nuget list + dotnet nuget search = 3 calls
    expect(cm.execInContainer).toHaveBeenCalledTimes(3);
  });
});

describe('ensureNuGetCredentialProvider', () => {
  it('skips install when plugin already exists', async () => {
    const cm = {
      execInContainer: vi.fn().mockResolvedValue({
        stdout: 'CredentialProvider.Microsoft.dll',
        stderr: '',
        exitCode: 0,
      }),
    } as unknown as ContainerManager;
    await ensureNuGetCredentialProvider(cm, 'ctr-1');
    expect(cm.execInContainer).toHaveBeenCalledTimes(1);
    expect((cm.execInContainer as ReturnType<typeof vi.fn>).mock.calls[0][1].join(' ')).toContain(
      'ls',
    );
  });

  it('installs when plugin is missing', async () => {
    const cm = {
      execInContainer: vi
        .fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 2 }) // ls fails
        .mockResolvedValueOnce({ stdout: 'Installation completed', stderr: '', exitCode: 0 }),
    } as unknown as ContainerManager;
    await ensureNuGetCredentialProvider(cm, 'ctr-1');
    expect(cm.execInContainer).toHaveBeenCalledTimes(2);
  });

  it('throws when install fails', async () => {
    const cm = {
      execInContainer: vi
        .fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 2 }) // ls fails
        .mockResolvedValueOnce({ stdout: '', stderr: 'curl: network error', exitCode: 1 }),
    } as unknown as ContainerManager;
    await expect(ensureNuGetCredentialProvider(cm, 'ctr-1')).rejects.toThrow(
      /Failed to install.*Credential Provider/,
    );
  });
});

describe('CREDENTIAL_GUARD_HOOK', () => {
  it('is a valid shell script', () => {
    expect(CREDENTIAL_GUARD_HOOK).toMatch(/^#!\/bin\/sh/);
  });

  it('detects ClearTextPassword pattern', () => {
    expect(CREDENTIAL_GUARD_HOOK).toContain('ClearTextPassword');
  });

  it('detects _authToken pattern', () => {
    expect(CREDENTIAL_GUARD_HOOK).toContain('_authToken');
  });

  it('exits with non-zero when credentials are found', () => {
    expect(CREDENTIAL_GUARD_HOOK).toContain('exit 1');
  });
});

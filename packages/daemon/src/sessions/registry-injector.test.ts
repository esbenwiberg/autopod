import type { PrivateRegistry } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  NUGET_CONFIG_PATH,
  NPM_RC_PATH,
  buildRegistryFiles,
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

  it('generates NuGet.config at user-level home path', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(NUGET_CONFIG_PATH);
    expect(files[0].content).toContain('my-pat');
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
  it('generates valid NuGet.config XML without <clear />', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'test-pat');
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<configuration>');
    expect(content).toContain('<packageSources>');
    // No <clear /> — user-level config must not wipe existing sources
    expect(content).not.toContain('<clear />');
    // No hardcoded nuget.org — workspace config handles public sources
    expect(content).not.toContain('nuget.org');
    expect(content).toContain('myorg-shared');
    expect(content).toContain('<packageSourceCredentials>');
    expect(content).toContain('ClearTextPassword');
    expect(content).toContain('test-pat');
    expect(content).toContain('</configuration>');
  });

  it('derives feed name from Azure DevOps URL', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/contoso/_packaging/internal-libs/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'pat');
    expect(content).toContain('contoso-internal-libs');
  });

  it('handles project-scoped feed URL', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/contoso/MyProject/_packaging/internal-libs/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'pat');
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
    const content = generateNuGetConfig(regs, 'pat');
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
    const content = generateNuGetConfig(regs, 'pat');
    // XML element names cannot start with a digit — must be prefixed
    expect(content).toContain('_365projectum-shared-libs');
    expect(content).not.toMatch(/<365/);
  });

  it('escapes XML special characters in PAT', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'pat<with>&"special\'chars');
    expect(content).toContain('&lt;');
    expect(content).toContain('&amp;');
    expect(content).toContain('&quot;');
    expect(content).toContain('&apos;');
    // Raw angle brackets should not appear in attribute values
    expect(content).not.toMatch(/value="[^"]*[<>][^"]*"/);
  });

  it('sanitizes feed name with special chars instead of XML-escaping element tags', () => {
    // Feed names derived from URLs should never produce XML entity escapes in tag names.
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://custom.registry.com/org&co/feed<1>/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'pat');
    // Element tag names in packageSourceCredentials must be clean XML names
    const credSection = content.split('<packageSourceCredentials>')[1];
    const tagNames = credSection.match(/<\/?([^>\s/]+)/g) ?? [];
    for (const tag of tagNames) {
      const name = tag.replace(/^<\/?/, '');
      if (name === 'add' || name === 'packageSourceCredentials') continue;
      // Must be a valid XML element name — no entity refs or special chars
      expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9._-]*$/);
    }
    // The generated name should be sanitized to valid XML element chars
    expect(content).toMatch(/<packageSourceCredentials>\s*\n\s*<[a-zA-Z_][a-zA-Z0-9._-]*>/);
  });

  it('produces valid element names for non-ADO URLs with dots', () => {
    const regs: PrivateRegistry[] = [
      {
        type: 'nuget',
        url: 'https://nuget.my-company.com/v3/index.json',
      },
    ];
    const content = generateNuGetConfig(regs, 'pat');
    // Should sanitize dots in hostname to valid element name
    expect(content).toContain('nuget.my-company.com-index.json');
    // Element should be well-formed
    const tagMatch = content.match(/<packageSourceCredentials>\s*\n\s*<([^>]+)>/);
    expect(tagMatch).toBeTruthy();
    expect(tagMatch![1]).toMatch(/^[a-zA-Z_][a-zA-Z0-9._-]*$/);
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

  it('passes when nuget config is valid', async () => {
    const cm = mockCm({
      'dotnet nuget': { stdout: 'Registered Sources:\n  1. nuget.org', stderr: '', exitCode: 0 },
    });
    const files = [{ path: NUGET_CONFIG_PATH, content: '<valid/>' }];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).resolves.toBeUndefined();
  });

  it('throws when nuget config is invalid', async () => {
    const cm = mockCm({
      'dotnet nuget': {
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
      'dotnet nuget': { stdout: 'Sources', stderr: '', exitCode: 0 },
    });
    const files = [
      { path: NPM_RC_PATH, content: 'ok' },
      { path: NUGET_CONFIG_PATH, content: 'ok' },
    ];
    await expect(validateRegistryFiles(cm, 'ctr-1', files)).resolves.toBeUndefined();
    expect(cm.execInContainer).toHaveBeenCalledTimes(2);
  });
});

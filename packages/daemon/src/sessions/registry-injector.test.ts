import type { PrivateRegistry } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { buildRegistryFiles, generateNpmrc, generateNuGetConfig } from './registry-injector.js';

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

  it('generates .npmrc for npm registries', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/workspace/.npmrc');
    expect(files[0].content).toContain('my-pat');
  });

  it('generates NuGet.config for nuget registries', () => {
    const regs: PrivateRegistry[] = [
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/workspace/NuGet.config');
    expect(files[0].content).toContain('my-pat');
  });

  it('generates both files when both types present', () => {
    const regs: PrivateRegistry[] = [
      { type: 'npm', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/' },
      { type: 'nuget', url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json' },
    ];
    const files = buildRegistryFiles(regs, 'my-pat');
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual(['/workspace/.npmrc', '/workspace/NuGet.config']);
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
  it('generates valid NuGet.config XML', () => {
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
    expect(content).toContain('<clear />');
    expect(content).toContain('nuget.org');
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
});

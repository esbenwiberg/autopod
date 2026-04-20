import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { buildSourceMap, resolveInheritance, validateInheritanceChain } from './inheritance.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'child',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'node server.js --port $PORT',
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
    mergeStrategy: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveInheritance', () => {
  it('should let child override parent simple fields', () => {
    const parent = makeProfile({
      name: 'parent',
      buildCommand: 'parent-build',
      defaultModel: 'sonnet',
    });
    const child = makeProfile({ name: 'child', buildCommand: 'child-build', extends: 'parent' });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.buildCommand).toBe('child-build');
    expect(resolved.name).toBe('child');
  });

  it('should inherit parent simple fields when child has null', () => {
    const parent = makeProfile({ name: 'parent', warmImageTag: 'my-image:latest' });
    const child = makeProfile({ name: 'child', warmImageTag: null, extends: 'parent' });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.warmImageTag).toBe('my-image:latest');
  });

  it('should append smokePages (parent first, child second)', () => {
    const parent = makeProfile({
      name: 'parent',
      smokePages: [{ path: '/parent-page' }],
    });
    const child = makeProfile({
      name: 'child',
      smokePages: [{ path: '/child-page' }],
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.smokePages).toEqual([{ path: '/parent-page' }, { path: '/child-page' }]);
  });

  it('should deep merge escalation config', () => {
    const parent = makeProfile({
      name: 'parent',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: false },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: false,
        askAi: { enabled: true, model: 'opus', maxCalls: 10 },
        advisor: { enabled: false },
        autoPauseAfter: 5,
        humanResponseTimeout: 3600,
      },
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.escalation.askHuman).toBe(false);
    expect(resolved.escalation.askAi.enabled).toBe(true);
    expect(resolved.escalation.askAi.model).toBe('opus');
    expect(resolved.escalation.askAi.maxCalls).toBe(10);
    expect(resolved.escalation.autoPauseAfter).toBe(5);
  });

  it('should deep merge escalation with partial child askAi', () => {
    const parent = makeProfile({
      name: 'parent',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: false },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: true,
        askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: false },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.escalation.askAi.enabled).toBe(true);
    expect(resolved.escalation.askAi.model).toBe('sonnet');
    expect(resolved.escalation.askAi.maxCalls).toBe(5);
  });

  it('should deep merge advisor config from escalation', () => {
    const parent = makeProfile({
      name: 'parent',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: true },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: false },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    // Child overrides parent advisor.enabled
    expect(resolved.escalation.advisor.enabled).toBe(false);
  });

  it('should let child override parent advisor config', () => {
    const parent = makeProfile({
      name: 'parent',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: true },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: true,
        askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
        advisor: { enabled: true },
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.escalation.advisor.enabled).toBe(true);
  });

  it('should concatenate customInstructions with separator', () => {
    const parent = makeProfile({ name: 'parent', customInstructions: 'parent rules' });
    const child = makeProfile({
      name: 'child',
      customInstructions: 'child rules',
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.customInstructions).toBe('parent rules\n\nchild rules');
  });

  it('should use parent customInstructions when child has none', () => {
    const parent = makeProfile({ name: 'parent', customInstructions: 'parent rules' });
    const child = makeProfile({ name: 'child', customInstructions: null, extends: 'parent' });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.customInstructions).toBe('parent rules');
  });

  it('should use child customInstructions when parent has none', () => {
    const parent = makeProfile({ name: 'parent', customInstructions: null });
    const child = makeProfile({
      name: 'child',
      customInstructions: 'child rules',
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.customInstructions).toBe('child rules');
  });

  it('should merge privateRegistries (parent first, child appended)', () => {
    const parent = makeProfile({
      name: 'parent',
      privateRegistries: [
        {
          type: 'nuget',
          url: 'https://pkgs.dev.azure.com/org/_packaging/shared/nuget/v3/index.json',
        },
      ],
    });
    const child = makeProfile({
      name: 'child',
      privateRegistries: [
        {
          type: 'npm',
          url: 'https://pkgs.dev.azure.com/org/_packaging/shared/npm/registry/',
          scope: '@org',
        },
      ],
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.privateRegistries).toHaveLength(2);
    expect(resolved.privateRegistries[0].type).toBe('nuget');
    expect(resolved.privateRegistries[1].type).toBe('npm');
  });

  it('should deduplicate privateRegistries by URL', () => {
    const feedUrl = 'https://pkgs.dev.azure.com/org/_packaging/shared/npm/registry/';
    const parent = makeProfile({
      name: 'parent',
      privateRegistries: [{ type: 'npm', url: feedUrl, scope: '@org' }],
    });
    const child = makeProfile({
      name: 'child',
      privateRegistries: [{ type: 'npm', url: feedUrl, scope: '@org' }],
      extends: 'parent',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.privateRegistries).toHaveLength(1);
  });

  it('should inherit registryPat from parent when child has null', () => {
    const parent = makeProfile({ name: 'parent', registryPat: 'parent-pat' });
    const child = makeProfile({ name: 'child', registryPat: null, extends: 'parent' });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.registryPat).toBe('parent-pat');
  });

  it('should let child override registryPat', () => {
    const parent = makeProfile({ name: 'parent', registryPat: 'parent-pat' });
    const child = makeProfile({ name: 'child', registryPat: 'child-pat', extends: 'parent' });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.registryPat).toBe('child-pat');
  });

  describe('mergeStrategy: replace', () => {
    it('replaces smokePages, discarding parent', () => {
      const parent = makeProfile({
        name: 'parent',
        smokePages: [{ path: '/parent' }],
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        smokePages: [{ path: '/child' }],
        mergeStrategy: { smokePages: 'replace' },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.smokePages).toEqual([{ path: '/child' }]);
    });

    it('replaces with empty smokePages array when mode is replace', () => {
      const parent = makeProfile({
        name: 'parent',
        smokePages: [{ path: '/parent' }],
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        smokePages: [],
        mergeStrategy: { smokePages: 'replace' },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.smokePages).toEqual([]);
    });

    it('nulls out customInstructions when child has null and mode is replace', () => {
      const parent = makeProfile({ name: 'parent', customInstructions: 'parent instructions' });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        customInstructions: null,
        mergeStrategy: { customInstructions: 'replace' },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.customInstructions).toBeNull();
    });

    it('replaces customInstructions with child value when mode is replace', () => {
      const parent = makeProfile({ name: 'parent', customInstructions: 'parent' });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        customInstructions: 'child',
        mergeStrategy: { customInstructions: 'replace' },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.customInstructions).toBe('child');
    });

    it('replaces escalation wholesale when mode is replace', () => {
      const parent = makeProfile({
        name: 'parent',
        escalation: {
          askHuman: false,
          askAi: { enabled: true, model: 'opus', maxCalls: 10 },
          advisor: { enabled: true },
          autoPauseAfter: 10,
          humanResponseTimeout: 7200,
        },
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        escalation: {
          askHuman: true,
          askAi: { enabled: false, model: 'sonnet', maxCalls: 1 },
          advisor: { enabled: false },
          autoPauseAfter: 2,
          humanResponseTimeout: 60,
        },
        mergeStrategy: { escalation: 'replace' },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.escalation.askAi.maxCalls).toBe(1);
      expect(resolved.escalation.askAi.model).toBe('sonnet');
      expect(resolved.escalation.autoPauseAfter).toBe(2);
    });

    it('replaces mcpServers, claudeMdSections, skills, privateRegistries', () => {
      const parent = makeProfile({
        name: 'parent',
        mcpServers: [{ name: 'p', command: 'p' }],
        claudeMdSections: [{ heading: 'p', content: 'p' }],
        skills: [{ name: 'p', source: { type: 'local', path: '/p' } }],
        privateRegistries: [{ type: 'npm', url: 'https://p.example.com/', scope: '@p' }],
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        mcpServers: [{ name: 'c', command: 'c' }],
        claudeMdSections: [{ heading: 'c', content: 'c' }],
        skills: [{ name: 'c', source: { type: 'local', path: '/c' } }],
        privateRegistries: [{ type: 'npm', url: 'https://c.example.com/', scope: '@c' }],
        mergeStrategy: {
          mcpServers: 'replace',
          claudeMdSections: 'replace',
          skills: 'replace',
          privateRegistries: 'replace',
        },
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.mcpServers.map((s) => s.name)).toEqual(['c']);
      expect(resolved.claudeMdSections.map((s) => s.heading)).toEqual(['c']);
      expect(resolved.skills.map((s) => s.name)).toEqual(['c']);
      expect(resolved.privateRegistries.map((r) => r.url)).toEqual(['https://c.example.com/']);
    });

    it('never inherits mergeStrategy (always taken from child)', () => {
      const parent = makeProfile({
        name: 'parent',
        mergeStrategy: { smokePages: 'replace' },
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        mergeStrategy: {},
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.mergeStrategy).toEqual({});
    });

    it('leaves merge behavior unchanged when mergeStrategy is empty', () => {
      const parent = makeProfile({
        name: 'parent',
        smokePages: [{ path: '/p' }],
        customInstructions: 'parent',
      });
      const child = makeProfile({
        name: 'child',
        extends: 'parent',
        smokePages: [{ path: '/c' }],
        customInstructions: 'child',
        mergeStrategy: {},
      });
      const resolved = resolveInheritance(child, parent);
      expect(resolved.smokePages).toEqual([{ path: '/p' }, { path: '/c' }]);
      expect(resolved.customInstructions).toBe('parent\n\nchild');
    });
  });

  it('should never inherit name, extends, createdAt, updatedAt', () => {
    const parent = makeProfile({
      name: 'parent',
      extends: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    });
    const child = makeProfile({
      name: 'child',
      extends: 'parent',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const resolved = resolveInheritance(child, parent);
    expect(resolved.name).toBe('child');
    expect(resolved.extends).toBe('parent');
    expect(resolved.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(resolved.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('buildSourceMap', () => {
  it('marks every field as own on base profiles (no parent)', () => {
    const base = makeProfile({ name: 'base', extends: null });
    const map = buildSourceMap(base, null);
    expect(map.buildCommand).toBe('own');
    expect(map.smokePages).toBe('own');
    expect(map.extends).toBe('own');
  });

  it('marks null simple fields as inherited on derived profiles', () => {
    const parent = makeProfile({ name: 'parent' });
    const child = makeProfile({
      name: 'child',
      extends: 'parent',
      buildCommand: null,
      customInstructions: null,
    });
    const map = buildSourceMap(child, parent);
    expect(map.buildCommand).toBe('inherited');
    expect(map.customInstructions).toBe('inherited');
  });

  it('marks non-null child fields as own', () => {
    const parent = makeProfile({ name: 'parent', buildCommand: 'parent' });
    const child = makeProfile({ name: 'child', extends: 'parent', buildCommand: 'child' });
    const map = buildSourceMap(child, parent);
    expect(map.buildCommand).toBe('own');
  });

  it('marks empty merge-special arrays as inherited, non-empty as merged', () => {
    const parent = makeProfile({
      name: 'parent',
      skills: [{ name: 'p', source: { type: 'local', path: '/p' } }],
    });
    const child = makeProfile({
      name: 'child',
      extends: 'parent',
      smokePages: [],
      skills: [{ name: 'c', source: { type: 'local', path: '/c' } }],
    });
    const map = buildSourceMap(child, parent);
    expect(map.smokePages).toBe('inherited');
    expect(map.skills).toBe('merged');
  });

  it('marks merge-special fields as own when mergeStrategy is replace', () => {
    const parent = makeProfile({ name: 'parent' });
    const child = makeProfile({
      name: 'child',
      extends: 'parent',
      smokePages: [{ path: '/child' }],
      mergeStrategy: { smokePages: 'replace' },
    });
    const map = buildSourceMap(child, parent);
    expect(map.smokePages).toBe('own');
  });

  it('always marks name, extends, createdAt, updatedAt, mergeStrategy as own', () => {
    const parent = makeProfile({ name: 'parent' });
    const child = makeProfile({
      name: 'child',
      extends: 'parent',
      buildCommand: null,
    });
    const map = buildSourceMap(child, parent);
    expect(map.name).toBe('own');
    expect(map.extends).toBe('own');
    expect(map.createdAt).toBe('own');
    expect(map.updatedAt).toBe('own');
    expect(map.mergeStrategy).toBe('own');
  });
});

describe('validateInheritanceChain', () => {
  it('should not throw for a simple parent-child chain', () => {
    const profiles: Record<string, string | null> = {
      child: 'parent',
      parent: null,
    };
    expect(() => validateInheritanceChain('child', (n) => profiles[n] ?? null)).not.toThrow();
  });

  it('should detect circular inheritance (A → B → A)', () => {
    const profiles: Record<string, string | null> = {
      a: 'b',
      b: 'a',
    };
    expect(() => validateInheritanceChain('a', (n) => profiles[n] ?? null)).toThrow(
      'Circular inheritance',
    );
  });

  it('should detect circular inheritance (A → B → C → A)', () => {
    const profiles: Record<string, string | null> = {
      a: 'b',
      b: 'c',
      c: 'a',
    };
    expect(() => validateInheritanceChain('a', (n) => profiles[n] ?? null)).toThrow(
      'Circular inheritance',
    );
  });

  it('should throw on chains deeper than 5 levels', () => {
    const profiles: Record<string, string | null> = {
      l1: 'l2',
      l2: 'l3',
      l3: 'l4',
      l4: 'l5',
      l5: 'l6',
      l6: null,
    };
    expect(() => validateInheritanceChain('l1', (n) => profiles[n] ?? null)).toThrow('too deep');
  });

  it('should allow exactly 5 levels', () => {
    const profiles: Record<string, string | null> = {
      l1: 'l2',
      l2: 'l3',
      l3: 'l4',
      l4: 'l5',
      l5: null,
    };
    expect(() => validateInheritanceChain('l1', (n) => profiles[n] ?? null)).not.toThrow();
  });
});

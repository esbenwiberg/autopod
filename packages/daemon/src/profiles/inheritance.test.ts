import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { resolveInheritance, validateInheritanceChain } from './inheritance.js';

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
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: false,
        askAi: { enabled: true, model: 'opus', maxCalls: 10 },
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
        autoPauseAfter: 3,
        humanResponseTimeout: 3600,
      },
    });
    const child = makeProfile({
      name: 'child',
      escalation: {
        askHuman: true,
        askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
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

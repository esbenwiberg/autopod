import { describe, expect, it } from 'vitest';
import { acDefinitionSchema, createPodRequestSchema } from './pod.schema.js';

describe('createPodRequestSchema', () => {
  it('preserves referenceRepos with sourceProfile through parse', () => {
    const parsed = createPodRequestSchema.parse({
      profileName: 'primary',
      task: 'do the thing',
      referenceRepos: [
        { url: 'https://github.com/org/lib', sourceProfile: 'duck' },
        { url: 'https://github.com/org/other' },
      ],
    });
    expect(parsed.referenceRepos).toEqual([
      { url: 'https://github.com/org/lib', sourceProfile: 'duck' },
      { url: 'https://github.com/org/other' },
    ]);
  });

  it('rejects malformed reference repo URLs', () => {
    expect(() =>
      createPodRequestSchema.parse({
        profileName: 'primary',
        task: 'do the thing',
        referenceRepos: [{ url: 'not a url' }],
      }),
    ).toThrow();
  });

  it('caps reference repos at 20 entries', () => {
    const refs = Array.from({ length: 21 }, (_, i) => ({
      url: `https://github.com/org/repo-${i}`,
    }));
    expect(() =>
      createPodRequestSchema.parse({
        profileName: 'primary',
        task: 'task',
        referenceRepos: refs,
      }),
    ).toThrow();
  });

  it('strips unknown fields by default (regression: referenceRepoPat must not survive)', () => {
    const parsed = createPodRequestSchema.parse({
      profileName: 'primary',
      task: 'task',
      referenceRepoPat: 'should-be-stripped',
    } as unknown as Parameters<typeof createPodRequestSchema.parse>[0]);
    expect(parsed).not.toHaveProperty('referenceRepoPat');
  });

  it('preserves single-brief metadata through parse', () => {
    const parsed = createPodRequestSchema.parse({
      profileName: 'primary',
      task: 'task',
      briefTitle: 'Contract brief',
      touches: ['packages/desktop/Sources/App.swift'],
      doesNotTouch: ['packages/daemon/src/pods/pod-manager.ts'],
    });
    expect(parsed.briefTitle).toBe('Contract brief');
    expect(parsed.touches).toEqual(['packages/desktop/Sources/App.swift']);
    expect(parsed.doesNotTouch).toEqual(['packages/daemon/src/pods/pod-manager.ts']);
  });
});

describe('acDefinitionSchema', () => {
  it.each(['none', 'api', 'web', 'cmd'] as const)('accepts type=%s', (type) => {
    const parsed = acDefinitionSchema.parse({
      type,
      outcome: 'The thing works',
      hint: type === 'cmd' ? 'rg -l X src/' : undefined,
    });
    expect(parsed.type).toBe(type);
    expect(parsed.outcome).toBe('The thing works');
  });

  it('rejects unknown ac types', () => {
    expect(() =>
      acDefinitionSchema.parse({
        type: 'shell',
        outcome: 'should fail',
      }),
    ).toThrow();
  });

  it('requires outcome', () => {
    expect(() =>
      acDefinitionSchema.parse({
        type: 'cmd',
        hint: 'echo hi',
      }),
    ).toThrow();
  });

  it.each(['expect-output', 'expect-no-output', 'exit-zero'] as const)(
    'accepts polarity=%s on cmd',
    (polarity) => {
      const parsed = acDefinitionSchema.parse({
        type: 'cmd',
        outcome: 'Command succeeds',
        hint: 'echo hi',
        polarity,
      });
      expect(parsed.type === 'cmd' && parsed.polarity).toBe(polarity);
    },
  );

  it('rejects unknown polarity values (regression: pass-on-200 corruption)', () => {
    expect(() =>
      acDefinitionSchema.parse({
        type: 'cmd',
        outcome: 'API returns 200',
        hint: 'curl -fsS http://x/health',
        polarity: 'pass-on-200',
      }),
    ).toThrow();
  });

  it('strips polarity on non-cmd types (Zod default; matches TS type)', () => {
    const parsed = acDefinitionSchema.parse({
      type: 'web',
      outcome: 'Page loads',
      polarity: 'exit-zero',
    } as unknown as Parameters<typeof acDefinitionSchema.parse>[0]);
    expect(parsed).not.toHaveProperty('polarity');
  });
});

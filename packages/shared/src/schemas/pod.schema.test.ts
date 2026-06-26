import { describe, expect, it } from 'vitest';
import { createPodRequestSchema, podResponseSchema } from './pod.schema.js';

describe('createPodRequestSchema', () => {
  it('rejects short Claude aliases in create-pod model overrides', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const result = createPodRequestSchema.safeParse({
        profileName: 'primary',
        task: 'task',
        model,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('canonical Claude model ID');
      }
    }
  });

  it('accepts canonical Claude IDs in create-pod model overrides', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6']) {
      const parsed = createPodRequestSchema.parse({
        profileName: 'primary',
        task: 'task',
        model,
      });
      expect(parsed.model).toBe(model);
    }
  });

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

  it('accepts validation suite per-pod overrides', () => {
    const parsed = createPodRequestSchema.parse({
      profileName: 'primary',
      task: 'task',
      options: { validationSuite: 'thin-with-facts' },
    });

    expect(parsed.options?.validationSuite).toBe('thin-with-facts');
  });

  it('rejects invalid validation suite per-pod overrides', () => {
    expect(() =>
      createPodRequestSchema.parse({
        profileName: 'primary',
        task: 'task',
        options: { validationSuite: 'weekend-mode' },
      }),
    ).toThrow();
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

describe('podResponseSchema', () => {
  it('accepts readinessReview null for old pod responses', () => {
    const parsed = podResponseSchema.parse({
      id: 'pod-old',
      readinessReview: null,
    });

    expect(parsed.readinessReview).toBeNull();
  });

  it('accepts compact readinessReview objects in pod responses', () => {
    const readinessReview = {
      status: 'ready',
      summary: 'No readiness findings need review.',
      computedAt: '2026-06-07T12:00:00.000Z',
      scope: 'pod',
      areas: [
        {
          area: 'validation',
          status: 'ready',
          title: 'Validation',
          summary: 'Latest blocking validation passed.',
          sourceRefs: [{ kind: 'validation', label: 'Validation', id: 'attempt-1' }],
        },
      ],
      findings: [],
      approval: null,
    };

    const parsed = podResponseSchema.parse({
      id: 'pod-ready',
      readinessReview,
    });

    expect(parsed.readinessReview).toEqual(readinessReview);
  });
});

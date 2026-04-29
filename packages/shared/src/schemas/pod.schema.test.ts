import { describe, expect, it } from 'vitest';
import { createPodRequestSchema } from './pod.schema.js';

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
});

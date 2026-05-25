import { describe, expect, it } from 'vitest';
import { partialPodOptionsSchema } from './action-definition.schema.js';
import { createProfileSchema, updateProfileSchema } from './profile.schema.js';

describe('profile schema advisory browser QA', () => {
  it('preserves explicit tri-state profile defaults', () => {
    expect(
      createProfileSchema.parse({
        name: 'base-enabled',
        advisoryBrowserQaEnabled: true,
      }).advisoryBrowserQaEnabled,
    ).toBe(true);

    expect(
      createProfileSchema.parse({
        name: 'base-disabled',
        advisoryBrowserQaEnabled: false,
      }).advisoryBrowserQaEnabled,
    ).toBe(false);

    expect(
      createProfileSchema.parse({
        name: 'base-inherit',
        advisoryBrowserQaEnabled: null,
      }).advisoryBrowserQaEnabled,
    ).toBeNull();
  });

  it('materializes missing derived-profile values as null for inheritance', () => {
    const parsed = createProfileSchema.parse({
      name: 'child',
      extends: 'parent',
    });

    expect(parsed.advisoryBrowserQaEnabled).toBeNull();
  });

  it('does not clobber inherited advisory browser QA on unrelated updates', () => {
    const parsed = updateProfileSchema.parse({
      customInstructions: 'tweak review guidance',
    });

    expect('advisoryBrowserQaEnabled' in parsed).toBe(false);
  });

  it('accepts a per-pod advisory browser QA override', () => {
    expect(
      partialPodOptionsSchema.parse({
        advisoryBrowserQaEnabled: true,
      }),
    ).toEqual({ advisoryBrowserQaEnabled: true });
  });
});

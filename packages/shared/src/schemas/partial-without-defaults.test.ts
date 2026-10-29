import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { launchOverridesSchema } from './launch-config.schema.js';
import { partialWithoutDefaults } from './partial-without-defaults.js';
import { createProfileSchema, mergeStrategySchema, updateProfileSchema } from './profile.schema.js';

describe('partial schema presence after Zod security migration', () => {
  it('preserves the existing typed preflight policy instead of silently stripping it', () => {
    for (const value of ['warn', 'block', null] as const) {
      expect(
        createProfileSchema.parse({ name: 'policy-fixture', preflightConflictPolicy: value })
          .preflightConflictPolicy,
      ).toBe(value);
      expect(updateProfileSchema.parse({ preflightConflictPolicy: value })).toEqual({
        preflightConflictPolicy: value,
      });
    }
    expect(updateProfileSchema.safeParse({ preflightConflictPolicy: 'bypass' }).success).toBe(
      false,
    );
  });
  it('retains catchall validation and refuses to silently discard object refinements', () => {
    const schema = partialWithoutDefaults(
      z.object({ value: z.string().default('creation') }).catchall(z.number()),
    );
    expect(schema.parse({ extra: 2 })).toEqual({ extra: 2 });
    expect(schema.safeParse({ extra: 'invalid' }).success).toBe(false);
    expect(() =>
      partialWithoutDefaults(
        z.object({ value: z.string() }).refine((value) => value.value === 'allowed'),
      ),
    ).toThrow(/refinement/);
  });
  it('preserves absent and explicit undefined without invoking creation defaults', () => {
    let defaults = 0;
    const schema = partialWithoutDefaults(
      z
        .object({
          value: z.string().default(() => {
            defaults++;
            return 'creation default';
          }),
        })
        .strict(),
    );
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ value: undefined })).toEqual({ value: undefined });
    expect(defaults).toBe(0);
    expect(schema.parse({ value: 'explicit' })).toEqual({ value: 'explicit' });
    expect(schema.safeParse({ value: 7 }).success).toBe(false);
    expect(schema.safeParse({ extra: true }).success).toBe(false);
  });
  it('does not reset unmentioned profile settings or nested launch overrides', () => {
    expect(updateProfileSchema.parse({})).toEqual({});
    expect(updateProfileSchema.parse({ buildTimeout: 47 })).toEqual({ buildTimeout: 47 });
    expect(updateProfileSchema.parse({ buildTimeout: undefined })).toEqual({
      buildTimeout: undefined,
    });
    expect(launchOverridesSchema.parse({})).toEqual({});
    expect(launchOverridesSchema.parse({ workflow: { tokenBudget: null }, pim: [] })).toEqual({
      workflow: { tokenBudget: null },
      pim: [],
    });
    expect(launchOverridesSchema.parse({ execution: { main: { memoryGb: 8 } } })).toEqual({
      execution: { main: { memoryGb: 8 } },
    });
    expect(launchOverridesSchema.safeParse({ workflow: { tokenBudget: -1 } }).success).toBe(false);
    expect(launchOverridesSchema.safeParse({ execution: { unapproved: true } }).success).toBe(
      false,
    );
  });
  it('keeps nested base defaults, nullable inheritance and partial enum record validation', () => {
    const base = createProfileSchema.parse({ name: 'security-fixture' });
    expect(base.escalation).toMatchObject({
      askHuman: true,
      askAi: { enabled: false, maxCalls: 5 },
      advisor: { enabled: false },
    });
    expect(
      createProfileSchema.parse({ name: 'derived-fixture', extends: 'base' }).escalation,
    ).toBeNull();
    expect(mergeStrategySchema.parse({})).toEqual({});
    expect(mergeStrategySchema.parse({ skills: 'replace' })).toEqual({ skills: 'replace' });
    expect(mergeStrategySchema.safeParse({ unapproved: 'replace' }).success).toBe(false);
    expect(mergeStrategySchema.safeParse({ skills: 'unapproved' }).success).toBe(false);
  });
});

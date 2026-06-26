import { describe, expect, it } from 'vitest';
import {
  mergeValidationPhaseSkips,
  resolvePodOptions,
  skippedPhasesForValidationSuite,
} from './pod-options.js';

describe('validation suites', () => {
  it('maps thin-with-facts to fast deterministic checks plus facts', () => {
    expect(skippedPhasesForValidationSuite('thin-with-facts')).toEqual([
      'sast',
      'pages',
      'review',
      'advisory',
    ]);
  });

  it('merges preset skips with custom profile skips', () => {
    expect(mergeValidationPhaseSkips('thin-with-facts', ['setup', 'review'])).toEqual([
      'sast',
      'pages',
      'review',
      'advisory',
      'setup',
    ]);
  });

  it('preserves legacy full validation for default PR pods', () => {
    expect(resolvePodOptions(null, null)).toMatchObject({
      agentMode: 'auto',
      output: 'pr',
      validate: true,
      validationSuite: 'full',
    });
  });

  it('allows profile defaults and per-pod overrides to select thin-with-facts', () => {
    const profileDefault = resolvePodOptions(null, { validationSuite: 'thin' });
    const resolved = resolvePodOptions(profileDefault, { validationSuite: 'thin-with-facts' });

    expect(resolved.validate).toBe(true);
    expect(resolved.validationSuite).toBe('thin-with-facts');
  });

  it('keeps old validate flags compatible with suites', () => {
    expect(resolvePodOptions(null, { validate: false }).validationSuite).toBe('off');
    expect(
      resolvePodOptions(
        {
          agentMode: 'auto',
          output: 'pr',
          validate: false,
          validationSuite: 'off',
          promotable: false,
        },
        { validate: true },
      ).validationSuite,
    ).toBe('full');
  });
});

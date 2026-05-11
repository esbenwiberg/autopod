import { describe, expect, it } from 'vitest';
import { BriefParseError } from '../errors.js';
import { parseBriefFrontmatter } from '../series/parse-briefs.js';
import type { AcDefinition, AcPolarity } from './ac.js';

// ---------------------------------------------------------------------------
// Type-level constraints (compile-time checks via @ts-expect-error)
// ---------------------------------------------------------------------------

it('type: cmd AC with polarity compiles', () => {
  const ac: AcDefinition = { type: 'cmd', outcome: 'legacy keys removed', polarity: 'exit-zero' };
  expect(ac.type).toBe('cmd');
});

it('type: web AC cannot carry polarity (TS rejects at compile time)', () => {
  // @ts-expect-error polarity is not allowed on non-cmd types
  const _ac: AcDefinition = { type: 'web', outcome: 'page renders', polarity: 'exit-zero' };
});

it('type: api AC cannot carry polarity (TS rejects at compile time)', () => {
  // @ts-expect-error polarity is not allowed on non-cmd types
  const _ac: AcDefinition = { type: 'api', outcome: 'endpoint returns 200', polarity: 'expect-output' };
});

it('type: none AC without hint or polarity compiles', () => {
  const ac: AcDefinition = { type: 'none', outcome: 'build passes' };
  expect(ac.outcome).toBe('build passes');
  expect(ac.hint).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Round-trip serialization for all three polarity values
// ---------------------------------------------------------------------------

describe('AcPolarity round-trip', () => {
  const polarities: AcPolarity[] = ['expect-output', 'expect-no-output', 'exit-zero'];

  for (const polarity of polarities) {
    it(`round-trips polarity "${polarity}"`, () => {
      const ac: AcDefinition = {
        type: 'cmd',
        outcome: 'grep finds nothing',
        hint: 'grep -n legacy packages/shared/src/types/ac.ts',
        polarity,
      };
      const json = JSON.stringify(ac);
      const parsed = JSON.parse(json) as AcDefinition;
      expect(parsed.type).toBe('cmd');
      expect(parsed.outcome).toBe(ac.outcome);
      expect(parsed.hint).toBe(ac.hint);
      if (parsed.type === 'cmd') {
        expect(parsed.polarity).toBe(polarity);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// parseBriefFrontmatter — legacy key rejection
// ---------------------------------------------------------------------------

describe('parseBriefFrontmatter legacy key rejection', () => {
  it('throws BriefParseError with offending field name for "test" key', () => {
    const content = `---
acceptance_criteria:
  - type: api
    test: GET /health
    pass: 200 ok
    fail: non-200
---
Body`;
    let thrown: unknown;
    try {
      parseBriefFrontmatter(content);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BriefParseError);
    expect((thrown as BriefParseError).message).toContain('"test"');
  });

  it('throws BriefParseError with offending field name for "pass" key', () => {
    const content = `---
acceptance_criteria:
  - type: none
    outcome: build passes
    pass: exit 0
---
Body`;
    expect(() => parseBriefFrontmatter(content)).toThrow(BriefParseError);
    expect(() => parseBriefFrontmatter(content)).toThrow('"pass"');
  });

  it('throws BriefParseError with offending field name for "fail" key', () => {
    const content = `---
acceptance_criteria:
  - type: none
    outcome: build passes
    fail: any error
---
Body`;
    expect(() => parseBriefFrontmatter(content)).toThrow(BriefParseError);
    expect(() => parseBriefFrontmatter(content)).toThrow('"fail"');
  });

  it('includes a line number in the error when detectable', () => {
    const content = `---
acceptance_criteria:
  - type: cmd
    outcome: legacy keys removed
    test: grep legacy src/
---
Body`;
    let thrown: BriefParseError | undefined;
    try {
      parseBriefFrontmatter(content);
    } catch (err) {
      if (err instanceof BriefParseError) thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(typeof thrown?.line).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// parseBriefFrontmatter — happy path (v2 shape)
// ---------------------------------------------------------------------------

describe('parseBriefFrontmatter happy path (v2 shape)', () => {
  it('parses a brief with one AC of each type', () => {
    const content = `---
acceptance_criteria:
  - type: none
    outcome: TypeScript compiles without errors
  - type: api
    outcome: POST /pods returns 201 with body.id
    hint: POST /api/pods
  - type: web
    outcome: /pr-dashboard renders with the header bar
    hint: /pr-dashboard
  - type: cmd
    outcome: legacy keys removed from shared types
    hint: grep -n 'pass:\\|fail:' packages/shared/src/types/ac.ts
    polarity: expect-no-output
---
Body`;
    const { frontmatter } = parseBriefFrontmatter(content);
    const acs = frontmatter.acceptance_criteria;
    expect(acs).toHaveLength(4);

    expect(acs?.[0]?.type).toBe('none');
    expect(acs?.[0]?.outcome).toBe('TypeScript compiles without errors');

    expect(acs?.[1]?.type).toBe('api');
    expect(acs?.[1]?.outcome).toBe('POST /pods returns 201 with body.id');
    expect(acs?.[1]?.hint).toBe('POST /api/pods');

    expect(acs?.[2]?.type).toBe('web');
    expect(acs?.[2]?.outcome).toBe('/pr-dashboard renders with the header bar');
    expect(acs?.[2]?.hint).toBe('/pr-dashboard');

    const cmdAc = acs?.[3];
    expect(cmdAc?.type).toBe('cmd');
    expect(cmdAc?.outcome).toBe('legacy keys removed from shared types');
    if (cmdAc?.type === 'cmd') {
      expect(cmdAc.polarity).toBe('expect-no-output');
    }
  });

  it('accepts AC without hint (hint is optional)', () => {
    const content = `---
acceptance_criteria:
  - type: none
    outcome: build exits cleanly
---
Body`;
    const { frontmatter } = parseBriefFrontmatter(content);
    expect(frontmatter.acceptance_criteria?.[0]?.outcome).toBe('build exits cleanly');
    expect(frontmatter.acceptance_criteria?.[0]?.hint).toBeUndefined();
  });

  it('accepts cmd AC without polarity (polarity is optional)', () => {
    const content = `---
acceptance_criteria:
  - type: cmd
    outcome: tests pass
    hint: npx pnpm test
---
Body`;
    const { frontmatter } = parseBriefFrontmatter(content);
    const ac = frontmatter.acceptance_criteria?.[0];
    expect(ac?.type).toBe('cmd');
    if (ac?.type === 'cmd') {
      expect(ac.polarity).toBeUndefined();
    }
  });
});

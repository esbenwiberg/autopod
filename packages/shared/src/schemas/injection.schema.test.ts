import { describe, expect, it } from 'vitest';
import { injectedSkillSchema } from './injection.schema.js';

describe('injectedSkillSchema', () => {
  it('accepts builtin skill sources', () => {
    expect(
      injectedSkillSchema.parse({
        name: 'code-council',
        source: { type: 'builtin' },
      }),
    ).toEqual({
      name: 'code-council',
      source: { type: 'builtin' },
    });
  });
});

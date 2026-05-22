import { describe, expect, it } from 'vitest';
import { extractSkillDescription, parseSkillFrontmatter } from './skill-frontmatter.js';

describe('skill frontmatter', () => {
  it('extracts inline descriptions', () => {
    const content = `---
name: review
description: Review PR changes
---

# /review
`;

    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'review',
      description: 'Review PR changes',
    });
  });

  it('extracts folded multiline descriptions as one line', () => {
    const content = `---
name: code-council
description: >
  Code-grounded for/against debate for decisions.
  Synthesis names the decisive trade-off.
---

# /code-council
`;

    expect(extractSkillDescription(content)).toBe(
      'Code-grounded for/against debate for decisions. Synthesis names the decisive trade-off.',
    );
  });

  it('returns null when the skill has no description frontmatter', () => {
    expect(extractSkillDescription('# /plain')).toBeNull();
  });
});

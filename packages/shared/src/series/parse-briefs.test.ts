import { describe, expect, it } from 'vitest';
import { extractMarkdownAcSection, parseBriefFrontmatter, parseBriefs } from './parse-briefs.js';

describe('parseBriefFrontmatter', () => {
  it('returns empty frontmatter and body as-is when no fence', () => {
    const { frontmatter, body } = parseBriefFrontmatter('Just a body');
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a body');
  });

  it('parses YAML frontmatter and trims body', () => {
    const content = '---\ntitle: My Brief\ndepends_on: [other]\n---\n\nBody text\n';
    const { frontmatter, body } = parseBriefFrontmatter(content);
    expect(frontmatter.title).toBe('My Brief');
    expect(frontmatter.depends_on).toEqual(['other']);
    expect(body).toBe('Body text');
  });

  it('parses structured acceptance_criteria from frontmatter', () => {
    const content =
      '---\nacceptance_criteria:\n  - type: api\n    test: GET /health\n    pass: 200 ok\n    fail: non-200\n---\nBody\n';
    const { frontmatter } = parseBriefFrontmatter(content);
    expect(frontmatter.acceptance_criteria).toHaveLength(1);
    expect(frontmatter.acceptance_criteria?.[0]?.type).toBe('api');
    expect(frontmatter.acceptance_criteria?.[0]?.test).toBe('GET /health');
  });
});

describe('extractMarkdownAcSection', () => {
  it('extracts AC section content', () => {
    const body =
      '## Overview\n\nSome text\n\n## Acceptance Criteria\n\n- [ ] First criterion\n- [ ] Second criterion\n\n## Next Section\n\nMore text';
    expect(extractMarkdownAcSection(body)).toBe('- [ ] First criterion\n- [ ] Second criterion');
  });

  it('handles AC section at end of file', () => {
    const body = '## Overview\n\nSome text\n\n## Acceptance Criteria\n\n- [ ] Only criterion';
    expect(extractMarkdownAcSection(body)).toBe('- [ ] Only criterion');
  });

  it('returns empty string when no AC section', () => {
    expect(extractMarkdownAcSection('## Overview\n\nNo ACs here')).toBe('');
  });

  it('is case-insensitive for heading', () => {
    const body = '## acceptance criteria\n\n- item';
    expect(extractMarkdownAcSection(body)).toBe('- item');
  });
});

describe('parseBriefs', () => {
  it('derives title from filename when no frontmatter title', () => {
    const briefs = parseBriefs([{ filename: '01-my-feature.md', content: 'Body text' }]);
    expect(briefs[0]?.title).toBe('my-feature');
  });

  it('uses frontmatter title when present', () => {
    const content = '---\ntitle: Custom Title\n---\nBody';
    const briefs = parseBriefs([{ filename: '01-ignored.md', content }]);
    expect(briefs[0]?.title).toBe('Custom Title');
  });

  it('first brief has no dependencies', () => {
    const briefs = parseBriefs([
      { filename: '01-first.md', content: 'Task 1' },
      { filename: '02-second.md', content: 'Task 2' },
    ]);
    expect(briefs[0]?.dependsOn).toEqual([]);
  });

  it('infers linear dependency chain from numeric prefix order', () => {
    const briefs = parseBriefs([
      { filename: '01-first.md', content: 'Task 1' },
      { filename: '02-second.md', content: 'Task 2' },
      { filename: '03-third.md', content: 'Task 3' },
    ]);
    expect(briefs[1]?.dependsOn).toEqual(['first']);
    expect(briefs[2]?.dependsOn).toEqual(['second']);
  });

  it('resolves explicit depends_on to brief titles', () => {
    const second = '---\ndepends_on: [01-first]\n---\nTask 2';
    const briefs = parseBriefs([
      { filename: '01-first.md', content: 'Task 1' },
      { filename: '02-second.md', content: second },
    ]);
    expect(briefs[1]?.dependsOn).toEqual(['first']);
  });

  it('prepends shared context to task body', () => {
    const briefs = parseBriefs(
      [{ filename: '01-task.md', content: 'Do this' }],
      'Shared context here',
    );
    expect(briefs[0]?.task).toContain('Shared context here');
    expect(briefs[0]?.task).toContain('Do this');
  });

  it('returns undefined acceptanceCriteria when brief has no ACs', () => {
    const briefs = parseBriefs([{ filename: '01-task.md', content: 'Just a task' }]);
    expect(briefs[0]?.acceptanceCriteria).toBeUndefined();
  });

  it('passes through YAML frontmatter acceptance_criteria as structured AcDefinition[]', () => {
    const content = `---
acceptance_criteria:
  - type: api
    test: GET /health
    pass: 200 ok
    fail: non-200
  - type: none
    test: npx pnpm build
    pass: exit 0
    fail: any error
---
Build the thing`;
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.acceptanceCriteria).toHaveLength(2);
    expect(briefs[0]?.acceptanceCriteria?.[0]?.type).toBe('api');
    expect(briefs[0]?.acceptanceCriteria?.[1]?.type).toBe('none');
  });

  it('parses markdown ## Acceptance Criteria section when no YAML ACs', () => {
    const content = `# Brief 01: My Task

## Objective

Do some work.

## Acceptance Criteria

- [ ] Types exported from shared
- [ ] Unit tests pass
- [ ] No TS errors

## Estimated Scope

Small`;
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.acceptanceCriteria).toHaveLength(3);
    expect(briefs[0]?.acceptanceCriteria?.[0]).toEqual({
      type: 'none',
      test: 'Types exported from shared',
      pass: 'criterion satisfied',
      fail: 'criterion not satisfied',
    });
    expect(briefs[0]?.acceptanceCriteria?.[1]?.test).toBe('Unit tests pass');
    expect(briefs[0]?.acceptanceCriteria?.[2]?.test).toBe('No TS errors');
  });

  it('YAML acceptance_criteria takes priority over markdown section', () => {
    const content = `---
acceptance_criteria:
  - type: web
    test: navigate to /dashboard
    pass: page renders
    fail: blank screen
---

## Acceptance Criteria

- [ ] This should be ignored

## End`;
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.acceptanceCriteria).toHaveLength(1);
    expect(briefs[0]?.acceptanceCriteria?.[0]?.type).toBe('web');
  });

  it('parses real-world style brief with checkbox ACs matching spec format', () => {
    const content = `# Brief 01: Runner protocol contracts

## Objective

Define the shared wire protocol and placement types in @autopod/shared.

## Acceptance Criteria

- [ ] \`RunnerIdentity\`, \`RunnerCapabilities\`, \`RunnerRecord\` types exported from shared.
- [ ] \`Placement\` discriminated union exported from shared.
- [ ] \`RUNNER_PROTOCOL_VERSION\` exported from constants.
- [ ] Daemon package builds cleanly after the move.
- [ ] No new runtime dependencies added to @autopod/shared.

## Estimated Scope

Files: 4 modified/created | Complexity: low`;
    const briefs = parseBriefs([{ filename: '01-protocol-contracts.md', content }]);
    expect(briefs[0]?.acceptanceCriteria).toHaveLength(5);
    expect(briefs[0]?.acceptanceCriteria?.every((ac) => ac.type === 'none')).toBe(true);
    expect(briefs[0]?.acceptanceCriteria?.[0]?.test).toContain('RunnerIdentity');
    expect(briefs[0]?.acceptanceCriteria?.[4]?.test).toContain('No new runtime dependencies');
  });
});

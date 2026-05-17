import { describe, expect, it } from 'vitest';
import { extractMarkdownAcSection, parseBriefFrontmatter, parseBriefs } from './parse-briefs.js';

describe('parseBriefFrontmatter', () => {
  it('returns empty frontmatter and body as-is when no fence', () => {
    const { frontmatter, body } = parseBriefFrontmatter('Just a body');
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a body');
  });

  it('throws BriefParseError when AC uses legacy "test" key', () => {
    const content = `---
acceptance_criteria:
  - type: cmd
    test: "grep -rn 'AddTPGraphClient\\|ITPGraphClient' /workspace"
    pass: match found
    fail: no match
---
Body`;
    expect(() => parseBriefFrontmatter(content)).toThrow('AC field "test" is not allowed');
  });

  it('parses YAML frontmatter and trims body', () => {
    const content = '---\ntitle: My Brief\ndepends_on: [other]\n---\n\nBody text\n';
    const { frontmatter, body } = parseBriefFrontmatter(content);
    expect(frontmatter.title).toBe('My Brief');
    expect(frontmatter.depends_on).toEqual(['other']);
    expect(body).toBe('Body text');
  });

  it('throws BriefParseError when AC "hint" is mangled into an object', () => {
    // A shell-command hint with unescaped quotes makes YAML collapse `hint`
    // and the following `polarity` key into one mapping.
    const content = `---
acceptance_criteria:
  - type: cmd
    outcome: reasoning event variant exists
    hint: {grep -nE "type":"reasoning",
    polarity: expect-output}
---
Body`;
    expect(() => parseBriefFrontmatter(content)).toThrow('AC field "hint" must be a string');
  });

  it('rejects acceptance_criteria frontmatter for runnable specs', () => {
    const content =
      '---\nacceptance_criteria:\n  - type: api\n    outcome: GET /health returns 200\n    hint: GET /api/health\n---\nBody\n';
    expect(() => parseBriefFrontmatter(content)).toThrow(
      'acceptance_criteria frontmatter is no longer supported',
    );
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

  it('does NOT prepend any series-level context to task body', () => {
    // Series-level shared docs (purpose.md, design.md) are now rendered as
    // labeled CLAUDE.md sections by the daemon, not concatenated into the
    // brief task body.
    const briefs = parseBriefs([{ filename: '01-task.md', content: 'Do this' }]);
    expect(briefs[0]?.task).toBe('Do this');
  });

  it('prepends per-brief context_files to task body when callback resolves them', () => {
    const briefs = parseBriefs(
      [{ filename: '01-task.md', content: '---\ncontext_files: [extra.md]\n---\nDo this' }],
      (path) => (path === 'extra.md' ? 'Extra reading content' : ''),
    );
    expect(briefs[0]?.task).toContain('Extra reading content');
    expect(briefs[0]?.task).toContain('Do this');
  });

  it('returns undefined acceptanceCriteria when brief has no ACs', () => {
    const briefs = parseBriefs([{ filename: '01-task.md', content: 'Just a task' }]);
    expect(briefs[0]?.acceptanceCriteria).toBeUndefined();
  });

  it('parses a sibling contract.yaml and uses it as title/dependencies', () => {
    const content = `---
title: Ignored brief title
---
Build the thing`;
    const contractContent = `contract_version: 1
title: Contract title
depends_on: [00-base]
scenarios:
  - id: behavior
    given: ["existing state"]
    when: ["the action runs"]
    then: ["the result is visible"]
required_facts:
  - id: fact-behavior
    proves: [behavior]
    kind: unit-test
    artifact:
      path: packages/shared/src/contract.test.ts
      change: create
    command: npx pnpm --filter @autopod/shared test -- contract.test.ts
human_review: []
`;
    const briefs = parseBriefs([{ filename: '01-task.md', content, contractContent }]);
    expect(briefs[0]?.title).toBe('Contract title');
    expect(briefs[0]?.dependsOn).toEqual(['00-base']);
    expect(briefs[0]?.contract?.requiredFacts[0]?.id).toBe('fact-behavior');
    expect(briefs[0]?.acceptanceCriteria).toBeUndefined();
  });

  it('rejects markdown ## Acceptance Criteria sections', () => {
    const content = `# Brief 01: My Task

## Objective

Do some work.

## Acceptance Criteria

- [ ] Types exported from shared
- [ ] Unit tests pass
- [ ] No TS errors

## Estimated Scope

Small`;
    expect(() => parseBriefs([{ filename: '01-task.md', content }])).toThrow(
      'Markdown Acceptance Criteria sections are no longer supported',
    );
  });

  it('rejects YAML acceptance_criteria even when markdown section exists', () => {
    const content = `---
acceptance_criteria:
  - type: web
    outcome: /dashboard renders with nav
    hint: /dashboard
---

## Acceptance Criteria

- [ ] This should be ignored

## End`;
    expect(() => parseBriefs([{ filename: '01-task.md', content }])).toThrow(
      'acceptance_criteria frontmatter is no longer supported',
    );
  });

  it('extracts require_sidecars from frontmatter (snake_case)', () => {
    const content =
      '---\ntitle: Wire Dagger pipeline\nrequire_sidecars: [dagger]\n---\nBuild the pipeline';
    const briefs = parseBriefs([{ filename: '02-pipeline.md', content }]);
    expect(briefs[0]?.requireSidecars).toEqual(['dagger']);
  });

  it('also accepts requireSidecars (camelCase) spelling', () => {
    const content = '---\nrequireSidecars: [dagger]\n---\nPipeline';
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.requireSidecars).toEqual(['dagger']);
  });

  it('normalizes empty and missing requireSidecars to undefined', () => {
    const noField = parseBriefs([{ filename: '01-a.md', content: 'Body' }]);
    expect(noField[0]?.requireSidecars).toBeUndefined();

    const emptyList = parseBriefs([
      { filename: '01-b.md', content: '---\nrequire_sidecars: []\n---\nBody' },
    ]);
    expect(emptyList[0]?.requireSidecars).toBeUndefined();
  });

  it('snake_case require_sidecars wins over camelCase when both are set', () => {
    const content = '---\nrequire_sidecars: [dagger]\nrequireSidecars: [postgres]\n---\nBody';
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.requireSidecars).toEqual(['dagger']);
  });

  it('parses touches and does_not_touch lists', () => {
    const content = `---
touches:
  - packages/daemon/src/pods/event-stream.ts
  - packages/daemon/src/db/migrations/
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
---
Body`;
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.touches).toEqual([
      'packages/daemon/src/pods/event-stream.ts',
      'packages/daemon/src/db/migrations/',
    ]);
    expect(briefs[0]?.doesNotTouch).toEqual(['packages/daemon/src/pods/pod-manager.ts']);
  });

  it('also accepts doesNotTouch (camelCase) spelling', () => {
    const content = '---\ndoesNotTouch: [src/foo.ts]\n---\nBody';
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.doesNotTouch).toEqual(['src/foo.ts']);
  });

  it('snake_case does_not_touch wins over camelCase when both are set', () => {
    const content = '---\ndoes_not_touch: [a.ts]\ndoesNotTouch: [b.ts]\n---\nBody';
    const briefs = parseBriefs([{ filename: '01-task.md', content }]);
    expect(briefs[0]?.doesNotTouch).toEqual(['a.ts']);
  });

  it('normalizes empty/missing touches and does_not_touch to undefined', () => {
    const noField = parseBriefs([{ filename: '01-a.md', content: 'Body' }]);
    expect(noField[0]?.touches).toBeUndefined();
    expect(noField[0]?.doesNotTouch).toBeUndefined();

    const emptyLists = parseBriefs([
      { filename: '01-b.md', content: '---\ntouches: []\ndoes_not_touch: []\n---\nBody' },
    ]);
    expect(emptyLists[0]?.touches).toBeUndefined();
    expect(emptyLists[0]?.doesNotTouch).toBeUndefined();
  });

  it('rejects real-world style brief with checkbox ACs', () => {
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
    expect(() => parseBriefs([{ filename: '01-protocol-contracts.md', content }])).toThrow(
      'Markdown Acceptance Criteria sections are no longer supported',
    );
  });
});

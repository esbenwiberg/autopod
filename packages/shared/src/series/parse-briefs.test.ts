import { describe, expect, it } from 'vitest';
import { parseBriefFrontmatter, parseBriefs } from './parse-briefs.js';

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
});

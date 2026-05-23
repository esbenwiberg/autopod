import { describe, expect, it } from 'vitest';
import { parseTaskMarkdown } from './task-markdown.js';

describe('parseTaskMarkdown', () => {
  it('splits structured task markdown into named sections', () => {
    const doc = parseTaskMarkdown(`
# Task
Add the mobile cards.

## Constraints
- Keep it compact.

## Test expectations
- parser test
`);

    expect(doc.usesStructuredCards).toBe(true);
    expect(doc.sections.map((section) => section.kind)).toEqual(['task', 'constraints', 'tests']);
    expect(doc.sections[0]?.body).toBe('Add the mobile cards.');
  });

  it('falls back to a task card for plain text', () => {
    const doc = parseTaskMarkdown('Add a small endpoint and tests.');

    expect(doc.usesStructuredCards).toBe(false);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]).toMatchObject({
      title: 'Task',
      kind: 'task',
      body: 'Add a small endpoint and tests.',
    });
  });

  it('does not split headings inside fenced code blocks', () => {
    const doc = parseTaskMarkdown(`
# Task
Render this:

\`\`\`md
## Not a section
\`\`\`

## Service
Build the view.
`);

    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]?.body).toContain('## Not a section');
    expect(doc.sections[1]).toMatchObject({ title: 'Service', kind: 'service' });
  });

  it('maps known desktop section headings to mobile card kinds', () => {
    const doc = parseTaskMarkdown(`
## DTOs
a
## Read Queries
b
## Does not touch
c
`);

    expect(doc.sections.map((section) => section.kind)).toEqual(['dtos', 'queries', 'excluded']);
  });
});

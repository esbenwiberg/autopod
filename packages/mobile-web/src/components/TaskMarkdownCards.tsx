import type { CSSProperties, ReactNode } from 'react';
import {
  type TaskMarkdownSection,
  type TaskMarkdownSectionKind,
  parseTaskMarkdown,
} from '../lib/task-markdown.js';

interface Props {
  markdown: string;
}

type MarkdownBlock =
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'unordered-list'; items: string[] }
  | { id: string; type: 'ordered-list'; items: string[] }
  | { id: string; type: 'heading'; level: number; text: string }
  | { id: string; type: 'code'; code: string; language?: string };

type WithoutId<T> = T extends { id: string } ? Omit<T, 'id'> : never;
type ParsedMarkdownBlock = WithoutId<MarkdownBlock>;

interface SectionStyle {
  label: string;
  accent: string;
}

export function TaskMarkdownCards({ markdown }: Props): JSX.Element {
  const document = parseTaskMarkdown(markdown);

  if (document.usesStructuredCards && document.sections.length > 0) {
    const primary = primarySection(document.sections);
    const details = document.sections.filter((section) => section.id !== primary.id);
    return (
      <section className="task-card-stack" aria-label="Task details">
        <TaskSectionCard section={primary} prominent />
        {details.map((section) => (
          <TaskSectionCard key={section.id} section={section} />
        ))}
      </section>
    );
  }

  return (
    <section className="task-card-stack" aria-label="Task details">
      <TaskSectionCard
        section={{
          id: 0,
          title: 'Task',
          body: markdown.trim(),
          level: 0,
          kind: 'task',
        }}
        prominent
      />
    </section>
  );
}

function primarySection(sections: TaskMarkdownSection[]): TaskMarkdownSection {
  return (
    sections.find((section) => section.kind === 'task') ??
    sections[0] ?? {
      id: 0,
      title: 'Task',
      body: '',
      level: 0,
      kind: 'task',
    }
  );
}

function TaskSectionCard({
  section,
  prominent = false,
}: {
  section: TaskMarkdownSection;
  prominent?: boolean;
}): JSX.Element {
  const style = styleForSection(section);
  return (
    <article
      className={`task-section-card ${prominent ? 'task-section-prominent' : ''}`}
      data-kind={section.kind}
      style={{ '--task-accent': style.accent } as CSSProperties}
    >
      <div className="task-section-accent" aria-hidden="true" />
      <div className="task-section-body">
        <div className="task-section-label">{style.label}</div>
        {prominent ? <h2 className="task-section-title">{section.title}</h2> : null}
        <MarkdownBlocks markdown={section.body} />
      </div>
    </article>
  );
}

function MarkdownBlocks({ markdown }: { markdown: string }): JSX.Element {
  const blocks = parseMarkdownBlocks(markdown);
  return (
    <div className="task-markdown">
      {blocks.map((block) => {
        switch (block.type) {
          case 'paragraph':
            return <p key={block.id}>{renderInline(block.text)}</p>;
          case 'unordered-list':
            return (
              <ul key={block.id}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'ordered-list':
            return (
              <ol key={block.id}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case 'heading':
            return (
              <h3
                key={block.id}
                className={`task-markdown-heading task-markdown-heading-${block.level}`}
              >
                {renderInline(block.text)}
              </h3>
            );
          case 'code':
            return (
              <pre key={block.id}>
                <code>{block.code}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let nextBlockId = 0;
  let paragraph: string[] = [];
  let list: { type: 'unordered-list' | 'ordered-list'; items: string[] } | null = null;
  let code: { language?: string; lines: string[] } | null = null;

  function pushBlock(block: ParsedMarkdownBlock): void {
    blocks.push({ ...block, id: `block-${nextBlockId}` } as MarkdownBlock);
    nextBlockId += 1;
  }

  function flushParagraph(): void {
    const text = paragraph.join(' ').trim();
    if (text) pushBlock({ type: 'paragraph', text });
    paragraph = [];
  }

  function flushList(): void {
    if (list && list.items.length > 0) {
      pushBlock({ type: list.type, items: list.items });
    }
    list = null;
  }

  function appendListItem(type: 'unordered-list' | 'ordered-list', item: string): void {
    flushParagraph();
    if (!list || list.type !== type) {
      flushList();
      list = { type, items: [] };
    }
    list.items.push(item.trim());
  }

  for (const line of lines) {
    if (code) {
      if (isFenceBoundary(line)) {
        pushBlock({ type: 'code', code: code.lines.join('\n'), language: code.language });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (isFenceBoundary(line)) {
      flushParagraph();
      flushList();
      code = { language: fenceLanguage(line), lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{4,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      flushList();
      pushBlock({
        type: 'heading',
        level: heading[1]?.length ?? 4,
        text: cleanHeading(heading[2] ?? ''),
      });
      continue;
    }

    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      appendListItem('unordered-list', unordered[1] ?? '');
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      appendListItem('ordered-list', ordered[1] ?? '');
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (code) pushBlock({ type: 'code', code: code.lines.join('\n'), language: code.language });
  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = text.split(/(`[^`\n]+`)/g);
  segments.forEach((segment) => {
    if (!segment) return;
    if (segment.startsWith('`') && segment.endsWith('`')) {
      nodes.push(<code key={`code-${segment}`}>{segment.slice(1, -1)}</code>);
    } else {
      nodes.push(segment);
    }
  });
  return nodes;
}

function isFenceBoundary(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function fenceLanguage(line: string): string | undefined {
  const language = line.trim().slice(3).trim().split(/\s+/)[0];
  return language || undefined;
}

function cleanHeading(text: string): string {
  return text.replace(/\s+#+$/, '').trim();
}

function styleForSection(section: TaskMarkdownSection): SectionStyle {
  const generic = section.kind === 'generic';
  return {
    label: generic ? section.title : labelForKind(section.kind),
    accent: accentForKind(section.kind),
  };
}

function labelForKind(kind: TaskMarkdownSectionKind): string {
  switch (kind) {
    case 'task':
      return 'Task';
    case 'dtos':
      return 'DTOs';
    case 'service':
      return 'Service';
    case 'queries':
      return 'Queries';
    case 'touches':
      return 'Touches';
    case 'excluded':
      return 'Out of Scope';
    case 'constraints':
      return 'Constraints';
    case 'tests':
      return 'Test Expectations';
    case 'generic':
      return 'Section';
  }
}

function accentForKind(kind: TaskMarkdownSectionKind): string {
  switch (kind) {
    case 'task':
      return 'var(--accent)';
    case 'dtos':
      return '#38bdf8';
    case 'service':
      return '#a78bfa';
    case 'queries':
      return '#2dd4bf';
    case 'touches':
      return '#60a5fa';
    case 'excluded':
      return 'var(--danger)';
    case 'constraints':
      return 'var(--warn)';
    case 'tests':
      return 'var(--ok)';
    case 'generic':
      return 'var(--muted)';
  }
}

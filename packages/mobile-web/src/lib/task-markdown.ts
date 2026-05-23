export type TaskMarkdownSectionKind =
  | 'task'
  | 'dtos'
  | 'service'
  | 'queries'
  | 'touches'
  | 'excluded'
  | 'constraints'
  | 'tests'
  | 'generic';

export interface TaskMarkdownSection {
  id: number;
  title: string;
  body: string;
  level: number;
  kind: TaskMarkdownSectionKind;
}

export interface TaskMarkdownDocument {
  sections: TaskMarkdownSection[];
  explicitHeadingCount: number;
  usesStructuredCards: boolean;
}

export function parseTaskMarkdown(markdown: string): TaskMarkdownDocument {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const sections: TaskMarkdownSection[] = [];
  let currentTitle = 'Task';
  let currentLevel = 0;
  let currentLines: string[] = [];
  let explicitHeadingCount = 0;
  let isInsideFence = false;

  function flushCurrentSection(): void {
    const body = trimmedMarkdown(currentLines);
    if (!body) return;
    sections.push({
      id: sections.length,
      title: currentTitle,
      body,
      level: currentLevel,
      kind: kindForTitle(currentTitle),
    });
  }

  for (const line of lines) {
    if (isFenceBoundary(line)) {
      isInsideFence = !isInsideFence;
      currentLines.push(line);
      continue;
    }

    const heading = isInsideFence ? null : headingIn(line);
    if (heading) {
      flushCurrentSection();
      currentTitle = heading.title;
      currentLevel = heading.level;
      currentLines = [];
      explicitHeadingCount += 1;
      continue;
    }

    currentLines.push(line);
  }

  flushCurrentSection();

  return {
    sections,
    explicitHeadingCount,
    usesStructuredCards:
      explicitHeadingCount > 1 || sections.some((section) => section.kind !== 'task'),
  };
}

function headingIn(line: string): { level: number; title: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('#')) return null;

  const marker = /^#{1,3}(?=\s)/.exec(trimmed);
  if (!marker) return null;

  const level = marker[0].length;
  const title = cleanedHeadingTitle(trimmed.slice(level));
  return title ? { level, title } : null;
}

function cleanedHeadingTitle(title: string): string {
  const trimmed = title.trim();
  const trailingHashes = /\s+#+$/.exec(trimmed);
  return trailingHashes ? trimmed.slice(0, trailingHashes.index).trim() : trimmed;
}

function trimmedMarkdown(lines: string[]): string {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;

  return start < end ? lines.slice(start, end).join('\n') : '';
}

function isFenceBoundary(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function kindForTitle(title: string): TaskMarkdownSectionKind {
  switch (normalizedHeading(title)) {
    case 'task':
      return 'task';
    case 'dto':
    case 'dtos':
    case 'data transfer objects':
      return 'dtos';
    case 'service':
    case 'read service':
    case 'workpackage service':
      return 'service';
    case 'query':
    case 'queries':
    case 'mediatr queries':
    case 'read queries':
      return 'queries';
    case 'touches':
    case 'touch points':
    case 'files touched':
      return 'touches';
    case 'does not touch':
    case 'doesnt touch':
    case 'out of scope':
    case 'not in scope':
    case 'excluded':
      return 'excluded';
    case 'constraint':
    case 'constraints':
      return 'constraints';
    case 'test expectations':
    case 'testing expectations':
    case 'tests':
    case 'test plan':
      return 'tests';
    default:
      return 'generic';
  }
}

function normalizedHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

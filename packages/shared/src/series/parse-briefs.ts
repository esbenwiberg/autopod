import { parse as parseYaml } from 'yaml';
import { parseAcList } from '../parse-ac-list.js';
import type { AcDefinition } from '../types/ac.js';

/**
 * YAML frontmatter shape for a brief markdown file. All fields are optional
 * — a body-only brief is still valid and gets its title from the filename.
 */
export interface BriefFrontmatter {
  title?: string;
  depends_on?: string[];
  context_files?: string[];
  handover_from?: string[];
  acceptance_criteria?: AcDefinition[];
}

/**
 * Parsed brief ready to POST to `/pods/series`. `dependsOn` references OTHER
 * brief titles (not pod IDs) — the daemon resolves titles to pod IDs at
 * creation time.
 */
export interface ParsedBrief {
  title: string;
  task: string;
  dependsOn: string[];
  acceptanceCriteria?: AcDefinition[];
}

/** Input for `parseBriefs` — one entry per .md file in the folder. */
export interface BriefFile {
  /** Filename without directory, e.g. `01-types.md`. */
  filename: string;
  /** File contents as a UTF-8 string. */
  content: string;
}

/**
 * Extract YAML frontmatter + body from a markdown string. Returns an empty
 * frontmatter object if no `---` fence is found.
 */
export function parseBriefFrontmatter(content: string): {
  frontmatter: BriefFrontmatter;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1] ?? '') ?? {}) as BriefFrontmatter;
  return { frontmatter, body: (match[2] ?? '').trim() };
}

/**
 * Extract the content of a `## Acceptance Criteria` section from a markdown
 * body. Returns the raw text between the heading and the next `##` heading (or
 * end of string), or an empty string if the section is absent.
 */
export function extractMarkdownAcSection(body: string): string {
  const match = body.match(/##\s+acceptance\s+criteria[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  return match ? (match[1] ?? '').trim() : '';
}

/** Numeric prefix from a filename, e.g. `01-types.md` → 1. Infinity if none. */
export function numericPrefix(filename: string): number {
  const m = filename.match(/^(\d+)/);
  return m ? Number.parseInt(m[1] ?? '0', 10) : Number.POSITIVE_INFINITY;
}

/**
 * Given a list of brief files, return parsed briefs with dependencies inferred
 * from either explicit `depends_on` frontmatter or the numeric-prefix order.
 * Does NOT perform any filesystem I/O — callers load files first.
 *
 * @param files Brief files, ALREADY sorted in the desired topological order
 *              (typically by `numericPrefix`).
 * @param sharedContext Optional shared context (e.g. contents of a sibling
 *                      `context.md`) prepended to every brief's task body
 *                      unless the brief sets its own `context_files`.
 * @param loadContextFile Optional resolver for `context_files` frontmatter —
 *                        returns the file content as a string, or '' if not
 *                        found. Daemons should restrict path access here.
 */
export function parseBriefs(
  files: BriefFile[],
  sharedContext = '',
  loadContextFile?: (path: string) => string,
): ParsedBrief[] {
  // Pre-parse every file once so dependency resolution can look up titles
  // without re-reading anything.
  type Pre = { frontmatter: BriefFrontmatter; body: string; title: string };
  const pre = new Map<string, Pre>();
  for (const f of files) {
    const { frontmatter, body } = parseBriefFrontmatter(f.content);
    const title = frontmatter.title ?? f.filename.replace(/^\d+-/, '').replace(/\.md$/, '');
    pre.set(f.filename, { frontmatter, body, title });
  }

  return files.map((f, i) => {
    const entry = pre.get(f.filename);
    if (!entry) {
      return {
        title: f.filename,
        task: '',
        dependsOn: [],
        acceptanceCriteria: undefined,
      };
    }
    const { frontmatter, body, title } = entry;

    // Build the task body: [shared context] + [explicit context_files] + body.
    const contextParts: string[] = [];
    if (sharedContext && !frontmatter.context_files) {
      contextParts.push(sharedContext);
    }
    if (loadContextFile && frontmatter.context_files) {
      for (const cf of frontmatter.context_files) {
        const cfContent = loadContextFile(cf);
        if (cfContent) contextParts.push(cfContent);
      }
    }
    const task = contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\n---\n\n${body}` : body;

    // Resolve explicit `depends_on` values to brief titles.
    const explicitDeps = (frontmatter.depends_on ?? []).map((dep) => {
      const depFile = files.find((x) => x.filename.startsWith(dep) || x.filename === `${dep}.md`);
      return depFile ? (pre.get(depFile.filename)?.title ?? dep) : dep;
    });

    // If no explicit deps and not the first brief, implicit linear chain:
    // depend on the immediately preceding brief.
    const dependsOn =
      explicitDeps.length > 0 || i === 0
        ? explicitDeps
        : (() => {
            const prevFile = files[i - 1];
            const prevTitle = prevFile ? (pre.get(prevFile.filename)?.title ?? '') : '';
            return prevTitle ? [prevTitle] : [];
          })();

    // YAML frontmatter acceptance_criteria takes priority; fall back to parsing
    // the markdown ## Acceptance Criteria section if no frontmatter ACs are set.
    let acceptanceCriteria: AcDefinition[] | undefined = frontmatter.acceptance_criteria;
    if (!acceptanceCriteria) {
      const mdSection = extractMarkdownAcSection(body);
      if (mdSection) {
        acceptanceCriteria = parseAcList(mdSection).map((test) => ({
          type: 'none' as const,
          test,
          pass: 'criterion satisfied',
          fail: 'criterion not satisfied',
        }));
      }
    }

    return {
      title,
      task,
      dependsOn,
      acceptanceCriteria,
    };
  });
}

import { parseDocument as parseYamlDocument } from 'yaml';
import { parseSpecContract } from '../contract.js';
import { BriefParseError } from '../errors.js';
import type { AcDefinition } from '../types/ac.js';
import type { SpecContract } from '../types/contract.js';

/**
 * YAML frontmatter shape for a brief markdown file. All fields are optional —
 * a body-only brief is still valid and gets its title from the filename.
 *
 * Fields that have both a snake_case and a camelCase spelling (`require_sidecars`,
 * `does_not_touch`) accept either; snake_case wins when both are set.
 */
export interface BriefFrontmatter {
  title?: string;
  depends_on?: string[];
  context_files?: string[];
  acceptance_criteria?: AcDefinition[];
  /**
   * Files this brief expects to modify. Advisory — the reviewer flags
   * deviations as discussion items, not failures. Use directory shorthand
   * (path ending in `/`) to mean "anything under this directory".
   */
  touches?: string[];
  /**
   * Files outside this brief's scope. Advisory — the reviewer flags
   * deviations as discussion items, not failures. Use directory shorthand
   * (path ending in `/`) to mean "anything under this directory".
   */
  does_not_touch?: string[];
  doesNotTouch?: string[];
  /**
   * Companion sidecars to spawn for this brief's pod (e.g. `[dagger]`). The
   * daemon validates each name against `profile.sidecars` and the profile's
   * `trustedSource` gate at pod-creation time — so a typo or an untrusted
   * profile fails the series fast rather than at pod-spawn time.
   */
  require_sidecars?: string[];
  requireSidecars?: string[];
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
  contract?: SpecContract;
  acceptanceCriteria?: AcDefinition[];
  /** Files this brief expects to modify (advisory). */
  touches?: string[];
  /** Files outside this brief's scope (advisory). */
  doesNotTouch?: string[];
  /** Per-pod sidecar requests (e.g. `['dagger']`). Undefined = no sidecars. */
  requireSidecars?: string[];
}

/** Input for `parseBriefs` — one entry per .md file in the folder. */
export interface BriefFile {
  /** Filename without directory, e.g. `01-types.md`. */
  filename: string;
  /** File contents as a UTF-8 string. */
  content: string;
  /** Optional sibling contract.yaml contents for contract-based specs. */
  contractContent?: string;
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
  const yamlText = match[1] ?? '';
  let frontmatter: BriefFrontmatter;
  try {
    // parseDocument collects errors without throwing — brief authors commonly use \| in grep
    // commands inside double-quoted YAML strings which strict parse rejects. Best-effort is fine.
    frontmatter = (parseYamlDocument(yamlText).toJS() ?? {}) as BriefFrontmatter;
  } catch (err) {
    throw new Error(
      `YAML frontmatter parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (frontmatter.acceptance_criteria) {
    validateAcItems(frontmatter.acceptance_criteria, yamlText);
    throw new BriefParseError(
      'acceptance_criteria frontmatter is no longer supported for runnable specs — use contract.yaml scenarios and required_facts.',
      lineOfFrontmatterKey(yamlText, 'acceptance_criteria'),
    );
  }
  return { frontmatter, body: (match[2] ?? '').trim() };
}

const LEGACY_AC_KEYS = ['test', 'pass', 'fail'] as const;

/**
 * Validate AC items from brief frontmatter:
 * - no legacy v1 keys (test/pass/fail)
 * - `hint`, when present, is a string — not an object. A shell-command hint
 *   with unescaped quotes (e.g. `grep -nE "type":"reasoning"`) makes the YAML
 *   parser collapse `hint` and the following key into a single mapping. Caught
 *   here, the whole object lands in the DB and crashes every client that
 *   decodes the pod's ACs.
 * Throws BriefParseError with the offending field name and best-effort line number.
 */
function validateAcItems(acs: AcDefinition[], yamlText: string): void {
  const lines = yamlText.split('\n');
  const lineOf = (key: string): number | undefined => {
    const i = lines.findIndex((l) => new RegExp(`^\\s+${key}\\s*:`).test(l));
    return i >= 0 ? i + 1 : undefined;
  };
  for (const ac of acs) {
    const obj = ac as unknown as Record<string, unknown>;
    for (const key of LEGACY_AC_KEYS) {
      if (key in obj) {
        throw new BriefParseError(
          `AC field "${key}" is not allowed in v2 schema — use "outcome" (was "test") or "hint" and remove "pass"/"fail". Found in acceptance_criteria item.`,
          lineOf(key),
        );
      }
    }
    if ('hint' in obj && obj.hint != null && typeof obj.hint !== 'string') {
      throw new BriefParseError(
        'AC field "hint" must be a string. A shell command with unescaped quotes ' +
          '(e.g. grep -nE "type":"reasoning") makes YAML parse it as an object — ' +
          'wrap the hint in single quotes.',
        lineOf('hint'),
      );
    }
  }
}

function lineOfFrontmatterKey(yamlText: string, key: string): number | undefined {
  const lines = yamlText.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
  return i >= 0 ? i + 1 : undefined;
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
 * Normalize an array of file/directory paths from frontmatter. Trims whitespace,
 * drops empty/non-string entries, and returns `undefined` for empty/missing input.
 * Directory shorthand (a trailing `/`) is preserved — the reviewer interprets it.
 */
function normalizePathList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Given a list of brief files, return parsed briefs with dependencies inferred
 * from either explicit `depends_on` frontmatter or the numeric-prefix order.
 * Does NOT perform any filesystem I/O — callers load files first.
 *
 * Series-level shared context (`purpose.md`, `design.md`) is NOT prepended here
 * — those are sent to the daemon as separate fields and rendered as labeled
 * sections in the agent's CLAUDE.md by `system-instructions-generator.ts`.
 *
 * @param files Brief files, ALREADY sorted in the desired topological order
 *              (typically by `numericPrefix`).
 * @param loadContextFile Optional resolver for per-brief `context_files`
 *                        frontmatter — returns the file content as a string,
 *                        or '' if not found. Daemons should restrict path
 *                        access here. When a brief lists `context_files`,
 *                        their content is prepended to that brief's task body.
 */
export function parseBriefs(
  files: BriefFile[],
  loadContextFile?: (path: string) => string,
): ParsedBrief[] {
  // Pre-parse every file once so dependency resolution can look up titles
  // without re-reading anything.
  type Pre = {
    frontmatter: BriefFrontmatter;
    body: string;
    title: string;
    contract?: SpecContract;
  };
  const pre = new Map<string, Pre>();
  for (const f of files) {
    const { frontmatter, body } = parseBriefFrontmatter(f.content);
    const contract = f.contractContent ? parseSpecContract(f.contractContent) : undefined;
    const title =
      contract?.title ?? frontmatter.title ?? f.filename.replace(/^\d+-/, '').replace(/\.md$/, '');
    pre.set(f.filename, { frontmatter, body, title, contract });
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
    const { frontmatter, body, title, contract } = entry;

    // Per-brief `context_files` are optional supplementary reads — load each
    // and prepend to the brief body. Series-level shared docs are handled
    // separately by the daemon (rendered as labeled CLAUDE.md sections).
    const contextParts: string[] = [];
    if (loadContextFile && frontmatter.context_files) {
      for (const cf of frontmatter.context_files) {
        const cfContent = loadContextFile(cf);
        if (cfContent) contextParts.push(cfContent);
      }
    }
    const task = contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\n---\n\n${body}` : body;

    // Resolve explicit `depends_on` values to brief titles.
    const explicitDeps = (contract?.dependsOn ?? frontmatter.depends_on ?? []).map((dep) => {
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
    const acceptanceCriteria: AcDefinition[] | undefined = undefined;
    if (!contract) {
      const mdSection = extractMarkdownAcSection(body);
      if (mdSection) {
        throw new BriefParseError(
          'Markdown Acceptance Criteria sections are no longer supported for runnable specs — use contract.yaml scenarios and required_facts.',
        );
      }
    }

    // Accept either snake_case or camelCase spellings; snake_case wins when both
    // are set. Normalize to camelCase for the ParsedBrief.
    const sidecarsRaw = frontmatter.require_sidecars ?? frontmatter.requireSidecars;
    const requireSidecars = normalizePathList(sidecarsRaw);
    const touches = normalizePathList(frontmatter.touches);
    const doesNotTouch = normalizePathList(frontmatter.does_not_touch ?? frontmatter.doesNotTouch);

    return {
      title,
      task,
      dependsOn,
      contract,
      acceptanceCriteria,
      touches,
      doesNotTouch,
      requireSidecars,
    };
  });
}

import { parseDocument as parseYamlDocument } from 'yaml';
import { parseSpecContract } from '../contract.js';
import { AutopodError } from '../errors.js';
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

function stableTopologicalOrder<T>(
  values: T[],
  keyOf: (value: T) => string,
  dependenciesOf: (value: T) => string[],
): { ordered: T[]; remainingKeys: string[] } {
  const indexByKey = new Map(values.map((value, index) => [keyOf(value), index]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const value of values) {
    const key = keyOf(value);
    const dependencies = Array.from(new Set(dependenciesOf(value)));
    indegree.set(key, dependencies.length);
    for (const dependency of dependencies) {
      const children = dependents.get(dependency) ?? [];
      children.push(key);
      dependents.set(dependency, children);
    }
  }

  const ready = values
    .filter((value) => indegree.get(keyOf(value)) === 0)
    .map(keyOf)
    .sort((a, b) => (indexByKey.get(a) ?? 0) - (indexByKey.get(b) ?? 0));
  const ordered: T[] = [];
  const orderedKeys = new Set<string>();
  const byKey = new Map(values.map((value) => [keyOf(value), value]));

  while (ready.length > 0) {
    const key = ready.shift();
    if (!key) continue;
    const value = byKey.get(key);
    if (value) {
      ordered.push(value);
      orderedKeys.add(key);
    }

    for (const child of dependents.get(key) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort((a, b) => (indexByKey.get(a) ?? 0) - (indexByKey.get(b) ?? 0));
      }
    }
  }

  return {
    ordered,
    remainingKeys: values.map(keyOf).filter((key) => !orderedKeys.has(key)),
  };
}

/**
 * Validate and topologically order parsed briefs received by the daemon.
 * Stable input ordering is preserved between independent roots and siblings.
 */
export function orderSeriesBriefs(briefs: ParsedBrief[]): ParsedBrief[] {
  const byTitle = new Map<string, ParsedBrief>();
  for (const brief of briefs) {
    if (byTitle.has(brief.title)) {
      throw new AutopodError(
        `Series contains duplicate brief title "${brief.title}". Brief titles must be unique so each dependency identifies exactly one parent.`,
        'DUPLICATE_SERIES_BRIEF_TITLE',
        400,
      );
    }
    byTitle.set(brief.title, brief);
  }

  for (const brief of briefs) {
    for (const dependency of brief.dependsOn) {
      if (!byTitle.has(dependency)) {
        throw new AutopodError(
          `Brief "${brief.title}" depends on unknown brief "${dependency}". Add that brief to the series or correct the dependsOn/depends_on reference.`,
          'UNKNOWN_SERIES_DEPENDENCY',
          400,
        );
      }
    }
  }

  const { ordered, remainingKeys } = stableTopologicalOrder(
    briefs,
    (brief) => brief.title,
    (brief) => brief.dependsOn,
  );
  if (remainingKeys.length > 0) {
    throw new AutopodError(
      `Series dependency cycle detected among briefs: ${remainingKeys
        .map((title) => `"${title}"`)
        .join(
          ', ',
        )}. Remove at least one dependency edge so every brief has an acyclic path from a root.`,
      'SERIES_DEPENDENCY_CYCLE',
      400,
    );
  }
  return ordered;
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
  return { frontmatter, body: (match[2] ?? '').trim() };
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
 * @param files Brief files in any stable discovery order. Contract/frontmatter
 *              dependencies are validated and topologically sorted here.
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
    filename: string;
    dependencyKey: string;
    frontmatter: BriefFrontmatter;
    body: string;
    title: string;
    contract?: SpecContract;
    dependencyFolders: string[];
  };
  const pre = new Map<string, Pre>();
  for (const [index, f] of files.entries()) {
    const { frontmatter, body } = parseBriefFrontmatter(f.content);
    const contract = f.contractContent ? parseSpecContract(f.contractContent) : undefined;
    const title =
      contract?.title ?? frontmatter.title ?? f.filename.replace(/^\d+-/, '').replace(/\.md$/, '');
    const dependencyKey = f.filename.replace(/\.md$/, '');
    const hasExplicitDependencies = contract !== undefined || frontmatter.depends_on !== undefined;
    const dependencyFolders = hasExplicitDependencies
      ? Array.from(new Set(contract?.dependsOn ?? frontmatter.depends_on ?? []))
      : index > 0
        ? [files[index - 1]?.filename.replace(/\.md$/, '') ?? '']
        : [];
    pre.set(dependencyKey, {
      filename: f.filename,
      dependencyKey,
      frontmatter,
      body,
      title,
      contract,
      dependencyFolders: dependencyFolders.filter(Boolean),
    });
  }

  for (const entry of pre.values()) {
    for (const dependency of entry.dependencyFolders) {
      if (!pre.has(dependency)) {
        throw new AutopodError(
          `Brief "${entry.title}" (folder "${entry.filename}") depends on unknown brief folder ` +
            `"${dependency}". Use a depends_on value that exactly matches a sibling brief folder.`,
          'UNKNOWN_SERIES_DEPENDENCY',
          400,
        );
      }
    }
  }

  const { ordered, remainingKeys } = stableTopologicalOrder(
    Array.from(pre.values()),
    (entry) => entry.dependencyKey,
    (entry) => entry.dependencyFolders,
  );
  if (remainingKeys.length > 0) {
    throw new AutopodError(
      `Series dependency cycle detected among folders: ${remainingKeys
        .map((folder) => `"${folder}"`)
        .join(
          ', ',
        )}. Remove at least one depends_on edge so every brief has an acyclic path from a root.`,
      'SERIES_DEPENDENCY_CYCLE',
      400,
    );
  }

  return ordered.map((entry) => {
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

    const dependsOn = entry.dependencyFolders.map(
      (dependency) => pre.get(dependency)?.title ?? dependency,
    );

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
      touches,
      doesNotTouch,
      requireSidecars,
    };
  });
}

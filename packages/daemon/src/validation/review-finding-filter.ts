import type { Logger } from 'pino';
import { parseDiffFilePaths } from './review-context-builder.js';

const DIFF_TRUNCATION_MARKER = '⚠ DIFF TRUNCATED:';

/**
 * Extensions we consider "code-y" enough that a bare basename like `Foo.cs`
 * is treated as a file-path citation (not e.g. a version number or URL host).
 * If a token contains `/` it's always treated as a path regardless of extension.
 */
const CODE_EXTENSIONS = new Set([
  'cs',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'm',
  'mm',
  'c',
  'h',
  'cc',
  'hh',
  'cpp',
  'hpp',
  'rb',
  'php',
  'vb',
  'fs',
  'fsx',
  'razor',
  'cshtml',
  'vbhtml',
  'aspx',
  'json',
  'yml',
  'yaml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'env',
  'md',
  'mdx',
  'rst',
  'txt',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'prisma',
  'proto',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'lock',
  'csproj',
  'sln',
  'fsproj',
  'vbproj',
  'props',
  'targets',
  'gradle',
  'tf',
  'tfvars',
  'bicep',
  'dockerfile',
  'editorconfig',
  'gitignore',
  'npmrc',
]);

/**
 * Match path/file tokens in free-form prose. Shape:
 *   (segment/)* basename (.ext)+
 * - Path segments allow letters, digits, dots, dashes, underscores (so
 *   `PF.Graph/` is a valid segment). Must end in `/`.
 * - Basename allows letters, digits, dashes, underscores — no dots, so the
 *   final `.ext` chain is unambiguous.
 * - Each `.ext` starts with a letter and is up to 8 chars (so `14.0.0` and
 *   URL fragments like `//github.com/foo/bar` don't match the right shape).
 */
const FILE_TOKEN_RE = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z][A-Za-z0-9]{0,7})+\b/g;

/** True if a token looks like a code/config file path the reviewer would cite. */
function looksLikeCodePath(token: string): boolean {
  const cleaned = token.replace(/[.,;:)\]]+$/, '');
  if (cleaned.includes('/')) return true;
  const ext = cleaned.split('.').pop()?.toLowerCase();
  return ext ? CODE_EXTENSIONS.has(ext) : false;
}

export interface FilterResult {
  issues: string[];
  droppedCount: number;
  /** Up to 5 dropped issues, for log/debug visibility. */
  droppedExamples: string[];
}

/**
 * Drops reviewer findings that cite ONLY files outside the diff. The reviewer's
 * agentic tier has Read access across the whole worktree and routinely flags
 * pre-existing code as if it were part of the PR. This is a deterministic
 * post-filter — any prompt-level rule can be silently ignored by the model;
 * this can't.
 *
 * Rules:
 * - Issue cites no file path → kept (general/structural finding).
 * - Issue cites at least one path that's in the diff → kept.
 * - Issue cites only paths outside the diff → dropped.
 * - Diff is truncated or empty of file headers → kept (we can't be sure).
 */
export function filterOutOfDiffFindings(issues: string[], diff: string): FilterResult {
  if (issues.length === 0) {
    return { issues, droppedCount: 0, droppedExamples: [] };
  }

  // Truncated diffs hide real file paths from us — refuse to drop anything.
  if (diff.includes(DIFF_TRUNCATION_MARKER)) {
    return { issues, droppedCount: 0, droppedExamples: [] };
  }

  const diffPaths = parseDiffFilePaths(diff);
  if (diffPaths.length === 0) {
    return { issues, droppedCount: 0, droppedExamples: [] };
  }

  const allowed = new Set<string>();
  for (const p of diffPaths) {
    allowed.add(p);
    const base = p.split('/').pop();
    if (base) allowed.add(base);
  }

  const kept: string[] = [];
  const droppedExamples: string[] = [];
  let droppedCount = 0;

  for (const issue of issues) {
    const tokens = issue.match(FILE_TOKEN_RE) ?? [];
    const codePaths = tokens.filter(looksLikeCodePath);

    if (codePaths.length === 0) {
      kept.push(issue);
      continue;
    }

    const referencesDiff = codePaths.some((c) => {
      const cleaned = c.replace(/[.,;:)\]]+$/, '');
      if (allowed.has(cleaned)) return true;
      const base = cleaned.split('/').pop();
      return !!base && allowed.has(base);
    });

    if (referencesDiff) {
      kept.push(issue);
    } else {
      droppedCount++;
      if (droppedExamples.length < 5) droppedExamples.push(issue);
    }
  }

  return { issues: kept, droppedCount, droppedExamples };
}

export interface ParsedReviewLike {
  status: 'pass' | 'fail' | 'uncertain';
  reasoning: string;
  issues: string[];
  requirementsCheck?: Array<{ criterion: string; met: boolean; note?: string }>;
  deviationsAssessment?: {
    disclosedDeviations: Array<{
      step: string;
      reasoning: string;
      verdict: 'justified' | 'questionable' | 'unjustified';
    }>;
    undisclosedDeviations: string[];
  };
}

/**
 * Filters out-of-diff findings from a parsed reviewer verdict. If the only
 * reason the model returned `fail` was these dropped findings, flips the
 * status to `pass` and notes the flip in `reasoning`. Logs a warning when
 * anything is dropped so operators can see when the model is misbehaving.
 */
export function applyDiffFilterToParsed<T extends ParsedReviewLike>(
  parsed: T | null,
  diff: string,
  log: Logger | undefined,
  tier: number,
): T | null {
  if (!parsed) return parsed;

  const filtered = filterOutOfDiffFindings(parsed.issues, diff);
  if (filtered.droppedCount === 0) return parsed;

  log?.warn(
    {
      tier,
      droppedCount: filtered.droppedCount,
      droppedExamples: filtered.droppedExamples,
    },
    'Dropped reviewer findings that cited code outside the diff',
  );

  const reqsAllMet = !parsed.requirementsCheck || parsed.requirementsCheck.every((r) => r.met);
  const noUndisclosed =
    !parsed.deviationsAssessment || parsed.deviationsAssessment.undisclosedDeviations.length === 0;
  const shouldFlipStatus =
    parsed.status === 'fail' && filtered.issues.length === 0 && reqsAllMet && noUndisclosed;

  return {
    ...parsed,
    issues: filtered.issues,
    status: shouldFlipStatus ? 'pass' : parsed.status,
    reasoning: shouldFlipStatus
      ? `${parsed.reasoning} [auto-pass: all flagged findings cited code outside the diff and were discarded]`
      : parsed.reasoning,
  };
}

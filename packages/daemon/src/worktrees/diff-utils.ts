/**
 * Shared helpers for normalizing and trimming unified diff output before
 * feeding it to AI reviewers or storing it on a pod row. Lives outside
 * `local-worktree-manager.ts` so the in-container diff fetcher
 * (`pods/pod-diff-fetcher.ts`) can apply identical post-processing without
 * importing the host-side worktree machinery.
 */

/**
 * Remove diff sections that only change file mode (chmod) with no content hunks.
 * Git records these as "old mode / new mode" lines without any +/- content.
 * They are environment artifacts inside containers and add noise to the AI reviewer.
 */
export function stripModeOnlyChanges(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      if (!section.startsWith('diff --git ')) return true;
      return /^@@/m.test(section) || /^[+-](?![+-][+-])/m.test(section);
    })
    .join('');
}

export const DIFF_EXCLUDE_PATHSPECS: readonly string[] = [
  // Daemon-injected code-intel caches. These are runtime state, not user changes.
  ':(exclude).serena',
  ':(exclude).serena/**',
  ':(exclude).roslyn-codelens',
  ':(exclude).roslyn-codelens/**',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)package-lock.json',
  ':(exclude)yarn.lock',
  ':(exclude)*.lock',
  ':(exclude)*.lockb',
  ':(exclude)go.sum',
  ':(exclude)*.min.js',
  ':(exclude)*.min.css',
];

/**
 * Trim a diff to roughly `maxLength` characters at file boundaries, never mid-hunk.
 * Appends a trailing warning listing the omitted file paths so the agent knows
 * what was dropped.
 */
export function truncateDiffAtFileBoundary(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) return diff;

  // Split into per-file chunks — the separator is "diff --git "
  const chunks = diff.split(/(?=^diff --git )/m).filter(Boolean);

  const included: string[] = [];
  const omitted: string[] = [];
  let size = 0;

  for (const chunk of chunks) {
    if (size + chunk.length <= maxLength) {
      included.push(chunk);
      size += chunk.length;
    } else {
      // Extract the file path from the header for the omitted list
      const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
      omitted.push(match ? match[1] : '(unknown file)');
    }
  }

  if (omitted.length === 0) return diff;

  const warning = `\n⚠ DIFF TRUNCATED: ${omitted.length} file${omitted.length > 1 ? 's' : ''} omitted (diff exceeded ${maxLength} chars).\nOmitted files — use read_file / Read tools to inspect them:\n${omitted.map((f) => `  - ${f}`).join('\n')}\n`;

  return included.join('') + warning;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';

/**
 * Read acceptance criteria from a file in the worktree.
 * Format: one criterion per line. Optional `- ` or `* ` prefix for markdown list compatibility.
 * Blank lines and lines containing only whitespace are dropped.
 */
export async function readAcFile(worktreePath: string, relativePath: string): Promise<string[]> {
  const fullPath = path.join(worktreePath, relativePath);

  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    throw new AutopodError(
      `Acceptance criteria file not found: ${relativePath}`,
      'AC_FILE_NOT_FOUND',
      400,
    );
  }

  const criteria = content
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => line.length > 0);

  if (criteria.length === 0) {
    throw new AutopodError(
      `Acceptance criteria file is empty: ${relativePath}`,
      'AC_FILE_EMPTY',
      400,
    );
  }

  return criteria;
}

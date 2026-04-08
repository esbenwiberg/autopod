import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError, parseAcList } from '@autopod/shared';

/**
 * Read acceptance criteria from a file in the worktree.
 * Format: one criterion per line. Common list prefixes are stripped automatically
 * (`- `, `* `, `1. `, `a) `, `- [ ] `, etc.).
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

  const criteria = parseAcList(content);

  if (criteria.length === 0) {
    throw new AutopodError(
      `Acceptance criteria file is empty: ${relativePath}`,
      'AC_FILE_EMPTY',
      400,
    );
  }

  return criteria;
}

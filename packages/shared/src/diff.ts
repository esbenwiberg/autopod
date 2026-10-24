import type { DiffFile, DiffStats } from './types/diff.js';

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileDiffs = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileDiffs) {
    const lines = chunk.split('\n');
    const headerLine = lines[0] ?? '';

    let path = '';
    let status: 'added' | 'modified' | 'deleted' = 'modified';

    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        path = line.slice(6);
      } else if (line.startsWith('+++ /dev/null')) {
        status = 'deleted';
      } else if (line.startsWith('--- /dev/null')) {
        status = 'added';
      } else if (line.startsWith('new file mode')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        status = 'deleted';
      }
    }

    if (!path) {
      for (const line of lines) {
        if (line.startsWith('--- a/')) {
          path = line.slice(6);
          break;
        }
      }
    }

    // Mode-only changes (e.g. chmod) have no +++ or --- lines — extract path from the
    // "a/<path> b/<path>" header that follows "diff --git "
    if (!path) {
      const modeOnlyMatch = headerLine.match(/^a\/(.+) b\/.+$/);
      if (modeOnlyMatch?.[1]) {
        path = modeOnlyMatch[1];
      }
    }

    if (path) {
      files.push({
        path,
        status,
        diff: `diff --git ${chunk}`,
      });
    }
  }

  return files;
}

function countLines(diff: string, prefix: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
      count++;
    }
  }
  return count;
}

export function statsForFiles(files: DiffFile[]): DiffStats {
  return {
    added: files.reduce((sum, f) => sum + countLines(f.diff, '+'), 0),
    removed: files.reduce((sum, f) => sum + countLines(f.diff, '-'), 0),
    changed: files.length,
  };
}

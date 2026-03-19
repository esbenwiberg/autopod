import type { PageResult } from '@autopod/shared';

const START_MARKER = '__AUTOPOD_PAGE_RESULTS_START__';
const END_MARKER = '__AUTOPOD_PAGE_RESULTS_END__';

/**
 * Extract PageResult[] JSON from noisy container exec stdout.
 * Looks for delimited markers, falls back to raw JSON extraction.
 */
export function parsePageResults(stdout: string): PageResult[] {
  // Try marker-based extraction first
  const startIdx = stdout.indexOf(START_MARKER);
  const endIdx = stdout.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const jsonStr = stdout.slice(startIdx + START_MARKER.length, endIdx).trim();
    try {
      return validateResults(JSON.parse(jsonStr));
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: try to find a JSON array in the output
  const match = stdout.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return validateResults(JSON.parse(match[0]));
    } catch {
      // Give up
    }
  }

  return [];
}

function validateResults(parsed: unknown): PageResult[] {
  if (!Array.isArray(parsed)) return [];

  return parsed.map((item: Record<string, unknown>) => ({
    path: String(item.path ?? ''),
    status: item.status === 'pass' ? 'pass' : 'fail',
    screenshotPath: String(item.screenshotPath ?? ''),
    consoleErrors: Array.isArray(item.consoleErrors) ? item.consoleErrors.map(String) : [],
    assertions: Array.isArray(item.assertions)
      ? item.assertions.map((a: Record<string, unknown>) => ({
          selector: String(a.selector ?? ''),
          type: a.type as 'exists' | 'text_contains' | 'visible' | 'count',
          expected: a.expected != null ? String(a.expected) : undefined,
          actual: a.actual != null ? String(a.actual) : undefined,
          passed: Boolean(a.passed),
        }))
      : [],
    loadTime: Number(item.loadTime ?? 0),
  }));
}

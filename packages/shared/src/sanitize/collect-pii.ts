import { PII_PATTERNS } from './patterns.js';

/**
 * Return the names of PII patterns that match at least once in `text`.
 * One entry per matched pattern; does not count repeated occurrences.
 * Used to populate action_audit.pii_categories and safety_events PII rows.
 */
export function collectPiiPatternNames(text: string): string[] {
  const names: string[] = [];
  for (const pattern of PII_PATTERNS) {
    pattern.regex.lastIndex = 0; // reset before test (global-flagged regex)
    if (pattern.regex.test(text)) names.push(pattern.name);
  }
  return names;
}

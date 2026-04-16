/**
 * Parse a newline-separated text block into individual acceptance criteria.
 *
 * Strips common list prefixes:
 *   - Markdown unordered: `- `, `* `
 *   - Checkbox: `- [ ] `, `- [x] `, `* [X] `
 *   - Numbered: `1. `, `2) `, `10. `
 *   - Lettered: `a) `, `b. `, `A) `
 *
 * Returns non-empty trimmed lines with prefixes removed.
 */
const PREFIX = /^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|[a-zA-Z][.)]\s+)/;

export function parseAcList(text: string): string[] {
  const parsed = text
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .map((line) => line.replace(PREFIX, ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Deduplicate exact matches (preserves first occurrence order)
  return [...new Set(parsed)];
}

/**
 * Truncates text with ellipsis if it exceeds maxLength.
 * Returns the original text if it fits within the limit.
 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength < 1) return '';
  if (text.length <= maxLength) return text;
  if (maxLength <= 2) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}\u2026`;
}

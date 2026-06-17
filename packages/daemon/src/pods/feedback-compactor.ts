export const DEFAULT_FEEDBACK_OUTPUT_BUDGET = 6_000;

export interface CompactTextOptions {
  maxChars?: number;
  headChars?: number;
}

export function compactText(
  text: string | null | undefined,
  options: CompactTextOptions = {},
): string {
  const raw = text?.trim() ?? '';
  const maxChars = options.maxChars ?? DEFAULT_FEEDBACK_OUTPUT_BUDGET;
  if (raw.length <= maxChars) return raw;

  const markerBudget = 80;
  const requestedHead = options.headChars ?? 1_000;
  const headChars = Math.max(0, Math.min(requestedHead, maxChars - markerBudget));
  const tailChars = Math.max(0, maxChars - headChars - markerBudget);
  const omitted = raw.length - headChars - tailChars;
  const head = raw.slice(0, headChars);
  const tail = tailChars > 0 ? raw.slice(raw.length - tailChars) : '';
  return `${head}\n\n... [truncated ${omitted} chars in the middle] ...\n\n${tail}`;
}

export function compactLines(lines: string[], options: CompactTextOptions = {}): string {
  return compactText(lines.filter(Boolean).join('\n'), options);
}

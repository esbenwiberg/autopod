/** Keep both command context and trailing failure details, never only thousands of successes. */
export function boundedDiagnosticOutput(output: string, limit = 10_000): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip intentional ANSI terminal escapes from diagnostics.
  const text = output.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = '\n\n[... output omitted; beginning and final diagnostics retained ...]\n\n';
  if (limit <= marker.length) return text.slice(-limit);
  const available = limit - marker.length;
  const head = Math.floor(available * 0.3);
  return text.slice(0, head) + marker + text.slice(-(available - head));
}

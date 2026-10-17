/** Single-quote shell escaping. Names can contain spaces and apostrophes (e.g. `O'Brien`),
 * so we wrap in single quotes and escape any embedded single quotes the standard way. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

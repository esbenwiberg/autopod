/** Capture a provider hint once at observation, never relative to a later retry. */
export function workerRetryDeadline(value: unknown, observedAt: number): string | null {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(observedAt)) return null;
  const hint = value.trim();
  let deadline: number;
  if (/^\d{1,8}$/.test(hint)) deadline = observedAt + Number(hint) * 1000;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(hint)) {
    deadline = Date.parse(hint);
    // Date.parse normalizes impossible calendar dates; they are not trusted hints.
    if (
      !Number.isFinite(deadline) ||
      new Date(deadline).toISOString().slice(0, 16) !== hint.slice(0, 16)
    )
      return null;
  } else return null;
  if (!Number.isFinite(deadline) || deadline < 0 || deadline > 253402300799999) return null;
  return new Date(deadline).toISOString();
}

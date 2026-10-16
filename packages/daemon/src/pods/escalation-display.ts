function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Presentation qualification only; never use this to authorize a decision or transition. */
export function isDisplayEscalation(value: unknown): boolean {
  if (value == null) return true;
  if (!isObject(value)) return false;
  if (!('payload' in value)) return typeof value.question === 'string';
  const payload = value.payload;
  return (
    ['id', 'podId', 'type', 'timestamp'].every((key) => typeof value[key] === 'string') &&
    isObject(payload) &&
    ['question', 'description', 'reason'].every(
      (key) => !(key in payload) || typeof payload[key] === 'string',
    )
  );
}

/** Select only existing display text; compact serialization applies its own length bound. */
export function escalationDisplaySummary(value: unknown): string | null {
  if (!isDisplayEscalation(value) || !isObject(value)) return null;
  const payload = 'payload' in value ? value.payload : value;
  if (!isObject(payload)) return null;
  for (const key of ['question', 'description', 'reason']) {
    if (typeof payload[key] === 'string') return payload[key];
  }
  return null;
}

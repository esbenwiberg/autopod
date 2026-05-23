// Hard cap on any single string field in a log record. Last-line-of-defense
// against runaway payloads filling the terminal; targeted redactions in
// runtimes/containers remain the primary fix.
const LOG_FIELD_MAX_BYTES = 16_384;

export function capLargeStrings(obj: unknown, depth = 0): unknown {
  if (depth > 4) return obj;
  if (typeof obj === 'string') {
    return obj.length > LOG_FIELD_MAX_BYTES
      ? `<truncated: ${obj.length} bytes, max ${LOG_FIELD_MAX_BYTES}>`
      : obj;
  }
  if (obj instanceof Error) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => capLargeStrings(v, depth + 1));
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = capLargeStrings(v, depth + 1);
    }
    return out;
  }
  return obj;
}

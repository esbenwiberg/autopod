import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('unsafe-wire-number');
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('invalid-wire-value');
  return result;
}
export function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function digest(value: unknown): string {
  return sha256(canonical(value));
}

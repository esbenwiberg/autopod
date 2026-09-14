import { createHash } from 'node:crypto';

export function canonicalConfiguration(value: unknown): string {
  if (value === undefined) throw new Error('Undefined configuration value');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConfiguration).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalConfiguration(v)}`)
    .join(',')}}`;
}
export function configurationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalConfiguration(value)).digest('hex');
}

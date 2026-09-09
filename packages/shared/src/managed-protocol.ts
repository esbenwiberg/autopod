import * as schemas from './types/managed-pod.js';

export const MANAGED_PROTOCOL_BUILD = 1;
export const MANAGED_CAPABILITIES = [
  'managed-pod-v1',
  'external-start-idempotency-v1',
  'artifact-export-v1',
  'artifact-input-v1',
  'source-draft-pr-v1',
  'source-finalize-v1',
  'managed-agent-session-v1',
  'managed-github-read-v1',
] as const;

/** Public failures contain a stable code, never raw Zod input or credentials. */
export function parseManagedRecord<K extends keyof typeof schemas>(
  schema: K,
  value: unknown,
): ReturnType<(typeof schemas)[K]['parse']> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('invalid-managed-contract');
  if (
    Array.from(serialized).reduce((size, char) => {
      const code = char.codePointAt(0)!;
      return size + (code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4);
    }, 0) >
    1024 * 1024
  ) {
    throw new Error('managed-payload-too-large');
  }
  const result = schemas[schema].safeParse(value);
  if (!result.success) throw new Error('invalid-managed-contract');
  return result.data as ReturnType<(typeof schemas)[K]['parse']>;
}

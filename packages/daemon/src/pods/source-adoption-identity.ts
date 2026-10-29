import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';

export const sourceHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function sourceAdoptionError(message: string, code = 'SOURCE_ADOPTION_BLOCKED'): never {
  throw new AutopodError(message, code, 409);
}

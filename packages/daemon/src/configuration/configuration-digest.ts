import { createHash } from 'node:crypto';

import { canonicalConfiguration } from '@autopod/shared';

export { canonicalConfiguration } from '@autopod/shared';
export function configurationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalConfiguration(value)).digest('hex');
}

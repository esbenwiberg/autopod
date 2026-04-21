import { PodNotFoundError } from '@autopod/shared';
import type { AutopodClient } from '../api/client.js';

const MIN_PREFIX_LENGTH = 3;
const FULL_ID_LENGTH = 8;

export async function resolvePodId(client: AutopodClient, partial: string): Promise<string> {
  if (!partial || partial.length < MIN_PREFIX_LENGTH) {
    throw new Error(`Pod ID must be at least ${MIN_PREFIX_LENGTH} characters`);
  }

  // If it looks like a full ID, return as-is
  if (partial.length >= FULL_ID_LENGTH) {
    return partial;
  }

  // Fetch all pods and match prefix
  const pods = await client.listSessions();
  const matches = pods.filter((s) => s.id.startsWith(partial));

  if (matches.length === 0) {
    throw new PodNotFoundError(partial);
  }

  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join(', ');
    throw new Error(`Ambiguous pod ID "${partial}" matches: ${ids}`);
  }

  return matches[0]!.id;
}

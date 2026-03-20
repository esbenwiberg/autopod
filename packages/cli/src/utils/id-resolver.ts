import { SessionNotFoundError } from '@autopod/shared';
import type { AutopodClient } from '../api/client.js';

const MIN_PREFIX_LENGTH = 3;
const FULL_ID_LENGTH = 8;

export async function resolveSessionId(client: AutopodClient, partial: string): Promise<string> {
  if (!partial || partial.length < MIN_PREFIX_LENGTH) {
    throw new Error(`Session ID must be at least ${MIN_PREFIX_LENGTH} characters`);
  }

  // If it looks like a full ID, return as-is
  if (partial.length >= FULL_ID_LENGTH) {
    return partial;
  }

  // Fetch all sessions and match prefix
  const sessions = await client.listSessions();
  const matches = sessions.filter((s) => s.id.startsWith(partial));

  if (matches.length === 0) {
    throw new SessionNotFoundError(partial);
  }

  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join(', ');
    throw new Error(`Ambiguous session ID "${partial}" matches: ${ids}`);
  }

  return matches[0]?.id;
}

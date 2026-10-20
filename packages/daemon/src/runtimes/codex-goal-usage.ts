import { z } from 'zod';
import { CodexRpcError } from './codex-app-server-client.js';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const codexThreadUsageSchema = z.object({
  threadId: z.string(),
  tokenUsage: z.object({ total: z.object({ totalTokens: counter }) }),
});

/** Goal tokensUsed excludes cache and post-completion output; the rollout retains all requests. */
export function codexGoalRolloutTokens(content: string, threadId: string): number {
  if (Buffer.byteLength(content) > 32 * 1024 * 1024)
    throw new CodexRpcError('USAGE_ROLLOUT_TOO_LARGE');
  let identity = false;
  let total = 0;
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry: { type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new CodexRpcError('USAGE_ROLLOUT_INVALID');
    } catch (error) {
      // A running native process can be in the middle of appending the last frame.
      if (error instanceof SyntaxError && index === lines.length - 1) break;
      throw new CodexRpcError('USAGE_ROLLOUT_INVALID');
    }
    if (entry.type === 'session_meta') {
      if (entry.payload?.id !== threadId) throw new CodexRpcError('SESSION_MISMATCH');
      identity = true;
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const parsed = z
        .object({ info: z.object({ total_token_usage: z.object({ total_tokens: counter }) }) })
        .safeParse(entry.payload);
      if (!parsed.success) throw new CodexRpcError('USAGE_UNAVAILABLE');
      const next = parsed.data.info.total_token_usage.total_tokens;
      if (next < total) throw new CodexRpcError('USAGE_RESET_UNCONFIRMED');
      total = next;
    }
  }
  if (!identity) throw new CodexRpcError('SESSION_MISMATCH');
  return total;
}

/** The native thread supplies a path, never permission to read arbitrary container files. */
export function codexGoalRolloutPath(path: string): string {
  if (
    !/^\/home\/autopod\/\.codex\/sessions\/(?:[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/)?rollout-[^/]+\.jsonl$/.test(
      path,
    ) ||
    path.includes('..')
  )
    throw new CodexRpcError('USAGE_ROLLOUT_PATH_INVALID');
  return path;
}

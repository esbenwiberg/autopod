import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AgentCompleteEvent } from '@autopod/shared';
import { checkedCodexUsage } from './codex-stream-parser.js';

interface Boundary {
  notBefore?: number;
  offset?: number;
}
function selection(sessionId: string, completion: AgentCompleteEvent, boundary: Boundary) {
  const responses: unknown[] = [];
  let native = false;
  let terminal = false;
  let offset = 0;
  return {
    append(line: string) {
      const start = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1; // Native rollout JSONL is UTF-8/LF.
      if (!line.trim()) return;
      // Large application/tool bodies are not accounting metadata. Never retain or replay them.
      if (line.length > 2 * 1024 * 1024) {
        const type = line.slice(0, 1024).match(/"type"\s*:\s*"([^"\\]*)"/)?.[1];
        if (type && !['session_meta', 'token_usage_record', 'event_msg'].includes(type)) return;
        throw new Error('Codex metadata record exceeds bounded line size');
      }
      const env = JSON.parse(line);
      if (!env || typeof env !== 'object' || Array.isArray(env))
        throw new Error('Invalid Codex rollout record');
      const payload = env.payload ?? env.msg ?? env;
      if (env.type === 'session_meta') {
        const version = String(payload.cli_version ?? '').match(/^(\d+)\.(\d+)\./);
        if (version && (Number(version[1]) > 0 || Number(version[2]) >= 160)) native = true;
      }
      if (env.type === 'token_usage_record') native = true;
      if (start < (boundary.offset ?? 0)) return;
      if (boundary.notBefore !== undefined) {
        const time = Date.parse(env.timestamp ?? '');
        if (!Number.isFinite(time) || time < boundary.notBefore) return;
      }
      if (env.type === 'token_usage_record') {
        if (payload.thread_id !== sessionId) throw new Error('Foreign Codex usage thread');
        const usage = checkedCodexUsage(payload.usage);
        if (
          !usage ||
          typeof payload.response_id !== 'string' ||
          payload.response_id.length > 512 ||
          typeof payload.turn_id !== 'string' ||
          payload.turn_id.length > 256
        )
          throw new Error('Invalid Codex response usage metadata');
        responses.push({
          type: 'token_usage_record',
          timestamp: env.timestamp,
          payload: {
            thread_id: payload.thread_id,
            response_id: payload.response_id,
            turn_id: payload.turn_id,
            turn_token_usage: checkedCodexUsage(payload.turn_token_usage),
            usage,
          },
        });
        terminal = false;
      } else if (payload.type === 'task_complete') terminal = true;
      else if (payload.type === 'task_started' || payload.type === 'turn_aborted') terminal = false;
    },
    result(): { native: boolean; lines?: string } {
      if (!native || !terminal || responses.length === 0) return { native };
      return {
        native,
        lines: [
          ...responses,
          {
            type: 'event_msg',
            timestamp: completion.timestamp,
            payload: { type: 'task_complete', last_agent_message: completion.result },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n'),
      };
    },
  };
}

/** Metadata only: never replay prompts/tool activity or a prior resumed turn as spend. */
export function nativeCompletionUsage(
  text: string,
  sessionId: string,
  completion: AgentCompleteEvent,
  notBefore?: number,
) {
  const selected = selection(sessionId, completion, { notBefore });
  for (const line of text.split('\n')) selected.append(line);
  return selected.result();
}

/** Stream a size-pinned snapshot, retaining metadata rather than the entire transcript. */
export async function readNativeCompletionUsage(
  path: string,
  size: number,
  sessionId: string,
  completion: AgentCompleteEvent,
  boundary: Boundary,
  deadline: number,
) {
  const selected = selection(sessionId, completion, boundary);
  if (size === 0) return selected.result();
  const input = createReadStream(path, {
    end: size - 1,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) selected.append(line);
  } finally {
    lines.close();
    input.destroy();
  }
  return selected.result();
}

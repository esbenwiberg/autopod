import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';

// NOTE: Codex CLI JSONL format is a best-effort mapping based on available
// documentation. The actual event types may differ — verify against real
// Codex CLI output before production use.

interface CodexEvent {
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Map a Codex event to an AgentEvent.
 *
 * Codex CLI event types (best-effort mapping):
 * - "task_start"       → AgentStatusEvent
 * - "file_read"        → AgentToolUseEvent
 * - "file_write"       → AgentFileChangeEvent
 * - "file_delete"      → AgentFileChangeEvent
 * - "command_run"      → AgentToolUseEvent
 * - "command_output"   → AgentToolUseEvent
 * - "message"          → AgentStatusEvent
 * - "task_complete"    → AgentCompleteEvent
 * - "error"            → AgentErrorEvent
 */
function mapEvent(event: CodexEvent, podId: string, logger?: Logger): AgentEvent | null {
  const ts = event.timestamp ?? new Date().toISOString();

  switch (event.type) {
    case 'task_start':
      return {
        type: 'status',
        timestamp: ts,
        message: (event.message as string) ?? 'Codex agent started',
      };

    case 'file_read':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'Read',
        input: { path: event.path },
        output: (event.content as string)?.slice(0, 500),
      };

    case 'file_write':
      return {
        type: 'file_change',
        timestamp: ts,
        path: event.path as string,
        action: (event.existed as boolean) ? 'modify' : 'create',
        diff: event.diff as string | undefined,
      };

    case 'file_delete':
      return {
        type: 'file_change',
        timestamp: ts,
        path: event.path as string,
        action: 'delete',
      };

    case 'command_run':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'Bash',
        input: { command: event.command },
      };

    case 'command_output':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'Bash',
        input: { command: event.command },
        output: (event.output as string)?.slice(0, 2000),
      };

    case 'message':
      return {
        type: 'status',
        timestamp: ts,
        message: event.message as string,
      };

    case 'task_complete':
      return {
        type: 'complete',
        timestamp: ts,
        result: (event.result as string) ?? 'Codex agent completed',
      };

    case 'error':
      return {
        type: 'error',
        timestamp: ts,
        message: (event.message as string) ?? 'Unknown Codex error',
        fatal: (event.fatal as boolean) ?? false,
      };

    default:
      logger?.debug({
        component: 'codex-stream-parser',
        podId,
        msg: `Unknown Codex event type: ${event.type}`,
      });
      return null;
  }
}

/**
 * Parses JSONL output from `codex exec --json` into normalized AgentEvent types.
 *
 * Each line is a JSON object. Malformed lines and unknown event types are
 * logged and skipped — never fatal.
 */
async function* parse(stream: Readable, podId: string, logger: Logger): AsyncIterable<AgentEvent> {
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      logger.warn({
        component: 'codex-stream-parser',
        podId,
        msg: `Failed to parse JSONL line: ${trimmed.slice(0, 200)}`,
      });
      continue;
    }

    const mapped = mapEvent(event, podId, logger);
    if (mapped) yield mapped;
  }
}

export const CodexStreamParser = { parse, mapEvent } as const;

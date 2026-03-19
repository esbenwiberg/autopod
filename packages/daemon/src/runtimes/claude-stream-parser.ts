import type { AgentEvent } from '@autopod/shared';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';

/**
 * Claude CLI `--output-format stream-json` event shape.
 * Each line is an NDJSON object with a `type` field.
 */
interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  tool_use_id?: string;
  content_type?: string;
  output?: string;
  result?: string;
  error?: { message: string };
  message?: string;
  [key: string]: unknown;
}

/** File-modifying tools whose output we map to AgentFileChangeEvent. */
const FILE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * Parses NDJSON output from `claude --output-format stream-json` into
 * normalized AgentEvent types. Same pattern as CodexStreamParser.
 */
export class ClaudeStreamParser {
  static async *parse(
    stream: Readable,
    sessionId: string,
    logger: Logger,
  ): AsyncIterable<AgentEvent> {
    const rl = createInterface({ input: stream });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        logger.warn({
          component: 'claude-stream-parser',
          sessionId,
          msg: `Failed to parse NDJSON line: ${trimmed.slice(0, 200)}`,
        });
        continue;
      }

      const mapped = ClaudeStreamParser.mapEvent(event, sessionId, logger);
      if (mapped) yield mapped;
    }
  }

  /**
   * Map a Claude stream-json event to an AgentEvent.
   *
   * Event mapping:
   * - system (subtype init)    → AgentStatusEvent (captures session_id)
   * - assistant (text content) → AgentStatusEvent
   * - assistant (tool_use)     → AgentFileChangeEvent or AgentToolUseEvent
   * - tool_result              → AgentToolUseEvent with output
   * - result                   → AgentCompleteEvent
   * - error                    → AgentErrorEvent
   */
  static mapEvent(
    event: ClaudeStreamEvent,
    sessionId: string,
    logger?: Logger,
  ): AgentEvent | null {
    const ts = new Date().toISOString();

    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init') {
          return {
            type: 'status',
            timestamp: ts,
            message: `Claude session initialized${event.session_id ? ` (${event.session_id})` : ''}`,
          };
        }
        return null;
      }

      case 'assistant': {
        // Content blocks can be text or tool_use
        if (!event.content || !Array.isArray(event.content)) return null;

        // Process the first meaningful content block
        for (const block of event.content) {
          if (block.type === 'text' && block.text) {
            return {
              type: 'status',
              timestamp: ts,
              message: block.text.slice(0, 2000),
            };
          }

          if (block.type === 'tool_use' && block.name) {
            if (FILE_CHANGE_TOOLS.has(block.name)) {
              const input = block.input ?? {};
              const filePath = (input.file_path ?? input.path ?? 'unknown') as string;
              return {
                type: 'file_change',
                timestamp: ts,
                path: filePath,
                action: block.name === 'Write' ? 'create' : 'modify',
              };
            }

            return {
              type: 'tool_use',
              timestamp: ts,
              tool: block.name,
              input: block.input ?? {},
            };
          }
        }
        return null;
      }

      case 'tool_result': {
        return {
          type: 'tool_use',
          timestamp: ts,
          tool: 'tool_result',
          input: { tool_use_id: event.tool_use_id },
          output: (event.output ?? event.content?.toString())?.slice(0, 2000),
        };
      }

      case 'result': {
        const resultText = event.result
          ?? (event.content && Array.isArray(event.content)
            ? event.content.map(b => b.text).filter(Boolean).join('\n')
            : undefined)
          ?? 'Claude agent completed';
        return {
          type: 'complete',
          timestamp: ts,
          result: typeof resultText === 'string' ? resultText : String(resultText),
        };
      }

      case 'error': {
        return {
          type: 'error',
          timestamp: ts,
          message: event.error?.message ?? event.message ?? 'Unknown Claude error',
          fatal: true,
        };
      }

      default: {
        logger?.debug({
          component: 'claude-stream-parser',
          sessionId,
          msg: `Unknown Claude event type: ${event.type}`,
        });
        return null;
      }
    }
  }
}

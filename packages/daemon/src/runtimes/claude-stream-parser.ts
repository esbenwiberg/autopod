import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';

/**
 * Claude CLI `--output-format stream-json` event shape.
 * Each line is an NDJSON object with a `type` field.
 *
 * NOTE: `assistant` and `user` events nest their content under `event.message.content`,
 * NOT at the top-level `event.content`.
 */
interface ClaudeStreamContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
}

interface ClaudeStreamMessage {
  role?: string;
  content?: ClaudeStreamContentBlock[];
}

interface ClaudeToolUseResult {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: ClaudeStreamMessage;
  tool_use_result?: ClaudeToolUseResult;
  result?: string;
  error?: { message: string };
  [key: string]: unknown;
}

/** File-modifying tools whose output we map to AgentFileChangeEvent. */
const FILE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * Parses NDJSON output from `claude --output-format stream-json` into
 * normalized AgentEvent types. Same pattern as CodexStreamParser.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: used as a namespace with static methods matching CodexStreamParser pattern
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
        // Non-JSON line — emit as a visible status event so it shows up in the TUI
        logger.info({
          component: 'claude-stream-parser',
          sessionId,
          raw: trimmed.slice(0, 500),
          msg: 'Non-JSON stdout line from claude',
        });
        yield {
          type: 'status',
          timestamp: new Date().toISOString(),
          message: `[stdout] ${trimmed.slice(0, 500)}`,
        };
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
  static mapEvent(event: ClaudeStreamEvent, sessionId: string, logger?: Logger): AgentEvent | null {
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
        // Content is nested under event.message.content (not top-level event.content)
        const content = event.message?.content;
        if (!content || !Array.isArray(content)) return null;

        // Process the first meaningful content block (skip 'thinking' blocks)
        for (const block of content) {
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

      case 'user': {
        // Tool results arrive as user messages with tool_result content blocks.
        // The tool output is also available at event.tool_use_result.stdout for convenience.
        const userContent = event.message?.content;
        if (!userContent || !Array.isArray(userContent)) return null;

        const toolResultBlock = userContent.find((b) => b.type === 'tool_result');
        if (!toolResultBlock) return null;

        const output = event.tool_use_result?.stdout ?? toolResultBlock.content?.slice(0, 2000);

        return {
          type: 'tool_use',
          timestamp: ts,
          tool: 'tool_result',
          input: { tool_use_id: toolResultBlock.tool_use_id },
          output: output?.slice(0, 2000),
        };
      }

      case 'result': {
        const resultText =
          (typeof event.result === 'string' ? event.result : null) ?? 'Claude agent completed';
        const costUsd =
          typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
        return {
          type: 'complete',
          timestamp: ts,
          result: typeof resultText === 'string' ? resultText : String(resultText),
          costUsd,
        };
      }

      case 'error': {
        return {
          type: 'error',
          timestamp: ts,
          message: event.error?.message ?? 'Unknown Claude error',
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


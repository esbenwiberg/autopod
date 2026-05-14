import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { canonicalModelKey, computeCost } from '@autopod/shared';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';

/**
 * Codex CLI JSONL parser.
 *
 * Mapped against the real `EventMsg` enum in
 * `openai/codex/codex-rs/protocol/src/protocol.rs` (snake_case via
 * `#[serde(tag = "type", rename_all = "snake_case")]`). Each line emitted by
 * `codex exec --json` is an `Event { id, msg }` with `msg.type` discriminating
 * the variant.
 *
 * Token usage arrives in `token_count` events ahead of `turn_complete`; the
 * parser carries the most recent snapshot and flushes it as part of the final
 * `complete` AgentEvent so pod-manager's accumulator (`pod-manager.ts:~2898`)
 * picks up `totalInputTokens` / `totalOutputTokens` the same way it does for
 * the Claude runtime.
 */

interface CodexEnvelope {
  id?: string;
  msg?: { type?: string; [key: string]: unknown };
  // Some channels emit flat events without the wrapper; accept both.
  type?: string;
  [key: string]: unknown;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenUsageInfo {
  total_token_usage?: CodexTokenUsage;
  last_token_usage?: CodexTokenUsage;
  model_context_window?: number | null;
}

const MAX_OUTPUT_LEN = 2000;
const MAX_REASONING_LEN = 4000;

function unwrap(env: CodexEnvelope): { type?: string; [key: string]: unknown } | null {
  if (env.msg && typeof env.msg === 'object') return env.msg as { type?: string };
  if (typeof env.type === 'string') return env as { type?: string };
  return null;
}

function tsOf(env: CodexEnvelope): string {
  const top = (env as Record<string, unknown>).timestamp;
  if (typeof top === 'string') return top;
  const inner = env.msg && (env.msg as Record<string, unknown>).timestamp;
  if (typeof inner === 'string') return inner;
  return new Date().toISOString();
}

function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function commandToString(cmd: unknown): string {
  if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  if (typeof cmd === 'string') return cmd;
  return '';
}

/**
 * Map a single Codex event payload (the unwrapped `msg`) to an AgentEvent.
 * Stateless — token accumulation and turn-completion stitching live in
 * `parse()` because they require carrying state across events.
 */
function mapEvent(event: CodexEnvelope, podId: string, logger?: Logger): AgentEvent | null {
  const msg = unwrap(event);
  if (!msg || typeof msg.type !== 'string') return null;
  const ts = tsOf(event);

  switch (msg.type) {
    case 'session_configured': {
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      return { type: 'status', timestamp: ts, message: 'Codex session ready', ...(sessionId !== undefined && { sessionId }) };
    }

    case 'turn_started':
      return { type: 'status', timestamp: ts, message: 'Codex turn started' };

    case 'agent_message': {
      const message = typeof msg.message === 'string' ? msg.message : '';
      if (!message) return null;
      return { type: 'status', timestamp: ts, message };
    }

    case 'agent_reasoning': {
      const text = truncate(msg.text, MAX_REASONING_LEN);
      if (!text) return null;
      return { type: 'reasoning', timestamp: ts, text, isRaw: false };
    }

    case 'agent_reasoning_raw_content': {
      const text = truncate(msg.text, MAX_REASONING_LEN) ?? truncate(msg.content, MAX_REASONING_LEN);
      if (!text) return null;
      return { type: 'reasoning', timestamp: ts, text, isRaw: true };
    }

    case 'exec_command_begin': {
      const command = commandToString(msg.command);
      const input: Record<string, unknown> = {
        call_id: msg.call_id,
        command,
      };
      if (typeof msg.cwd === 'string') input.cwd = msg.cwd;
      return { type: 'tool_use', timestamp: ts, tool: 'Bash', input };
    }

    case 'exec_command_end': {
      // Real fields vary slightly across Codex versions — pull whatever's
      // present. `aggregated_output` is the most informative when set;
      // fall back to stdout/stderr concatenation, then formatted_output.
      const stdout = typeof msg.stdout === 'string' ? msg.stdout : '';
      const stderr = typeof msg.stderr === 'string' ? msg.stderr : '';
      const aggregated =
        typeof msg.aggregated_output === 'string'
          ? msg.aggregated_output
          : typeof msg.formatted_output === 'string'
            ? msg.formatted_output
            : [stdout, stderr].filter(Boolean).join('\n');
      const exit = typeof msg.exit_code === 'number' ? ` (exit ${msg.exit_code})` : '';
      const out = `${aggregated}${exit}`;
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'Bash',
        input: { call_id: msg.call_id },
        output: truncate(out, MAX_OUTPUT_LEN) ?? '',
      };
    }

    case 'mcp_tool_call_begin': {
      const inv = (msg.invocation as Record<string, unknown> | undefined) ?? {};
      const toolName =
        typeof inv.tool === 'string'
          ? inv.tool
          : typeof inv.name === 'string'
            ? inv.name
            : 'mcp_tool';
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: toolName,
        input: {
          call_id: msg.call_id,
          server: inv.server,
          arguments: inv.arguments,
        },
      };
    }

    case 'mcp_tool_call_end': {
      const inv = (msg.invocation as Record<string, unknown> | undefined) ?? {};
      const toolName =
        typeof inv.tool === 'string'
          ? inv.tool
          : typeof inv.name === 'string'
            ? inv.name
            : 'mcp_tool';
      const result = msg.result;
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: toolName,
        input: { call_id: msg.call_id },
        output: truncate(
          typeof result === 'string' ? result : JSON.stringify(result),
          MAX_OUTPUT_LEN,
        ),
      };
    }

    case 'web_search_begin':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'WebSearch',
        input: { call_id: msg.call_id },
      };

    case 'web_search_end':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'WebSearch',
        input: { call_id: msg.call_id, query: msg.query },
      };

    case 'image_generation_begin':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'ImageGeneration',
        input: { call_id: msg.call_id },
      };

    case 'image_generation_end':
      return {
        type: 'tool_use',
        timestamp: ts,
        tool: 'ImageGeneration',
        input: { call_id: msg.call_id },
        output: truncate(typeof msg.result === 'string' ? msg.result : undefined, MAX_OUTPUT_LEN),
      };

    case 'warning': {
      const message = typeof msg.message === 'string' ? msg.message : 'Codex warning';
      return { type: 'status', timestamp: ts, message: `Warning: ${message}` };
    }

    case 'error':
    case 'turn_aborted': {
      const message =
        typeof msg.message === 'string'
          ? msg.message
          : msg.type === 'turn_aborted'
            ? 'Codex turn aborted'
            : 'Codex error';
      return { type: 'error', timestamp: ts, message, fatal: true };
    }

    // Stateful events handled in `parse()` — `mapEvent` returns null so a
    // single-event-mapping caller treats them as a no-op rather than emitting
    // half-formed output.
    case 'token_count':
    case 'turn_complete':
    case 'patch_apply_end': // yields one file_change per file — handled in parse()
      return null;

    // High-frequency or interactive variants we deliberately ignore. Listing
    // them explicitly so unknown-type logging stays useful.
    case 'agent_message_delta':
    case 'agent_reasoning_delta':
    case 'agent_reasoning_raw_content_delta':
    case 'patch_apply_begin':
    case 'patch_apply_updated':
    case 'exec_command_output_delta':
    case 'exec_approval_request':
    case 'apply_patch_approval_request':
    case 'request_permissions':
    case 'request_user_input':
    case 'elicitation_request':
    case 'thread_name_updated':
    case 'thread_goal_updated':
    case 'thread_rolled_back':
    case 'context_compacted':
    case 'model_reroute':
    case 'shutdown_complete':
      return null;

    default:
      logger?.debug({
        component: 'codex-stream-parser',
        podId,
        msg: `Unknown Codex event type: ${msg.type}`,
      });
      return null;
  }
}

/**
 * Parse `codex exec --json` JSONL into `AgentEvent` stream.
 *
 * Carries `token_count` snapshots forward and folds them into the
 * `turn_complete` → `AgentCompleteEvent` so token telemetry persists via the
 * same pod-manager accumulator that handles Claude usage.
 *
 * Malformed lines are warned-and-skipped — never fatal.
 */
async function* parse(stream: Readable, podId: string, logger: Logger): AsyncIterable<AgentEvent> {
  const rl = createInterface({ input: stream });
  let latestUsage: CodexTokenUsage | undefined;
  let latestModel: string | null = null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let env: CodexEnvelope;
    try {
      env = JSON.parse(trimmed);
    } catch {
      logger.warn({
        component: 'codex-stream-parser',
        podId,
        msg: `Failed to parse JSONL line: ${trimmed.slice(0, 200)}`,
      });
      continue;
    }

    const msg = unwrap(env);
    if (!msg || typeof msg.type !== 'string') continue;

    if (msg.type === 'session_configured' && typeof msg.model === 'string') {
      latestModel = msg.model;
    }

    if (msg.type === 'token_count') {
      const info = msg.info as CodexTokenUsageInfo | undefined;
      const usage = info?.total_token_usage ?? info?.last_token_usage;
      if (usage) latestUsage = usage;
      continue;
    }

    if (msg.type === 'patch_apply_end') {
      const changes = msg.changes as Record<string, { type?: string }> | undefined;
      if (changes) {
        const ts = tsOf(env);
        for (const [filePath, change] of Object.entries(changes)) {
          const ct = change?.type;
          const action: 'create' | 'modify' | 'delete' =
            ct === 'create' ? 'create' : ct === 'delete' ? 'delete' : 'modify';
          yield { type: 'file_change', timestamp: ts, path: filePath, action };
        }
      }
      continue;
    }

    if (msg.type === 'turn_complete') {
      const result =
        typeof msg.last_agent_message === 'string' && msg.last_agent_message.length > 0
          ? msg.last_agent_message
          : 'Codex turn complete';
      const ts = tsOf(env);
      const inputTokens = latestUsage?.input_tokens;
      const outputTokens = latestUsage?.output_tokens;
      let costUsd: number | undefined;
      if (latestModel !== null) {
        const key = canonicalModelKey(latestModel);
        if (key === null) {
          logger.warn({
            component: 'codex-stream-parser',
            podId,
            msg: `No pricing entry for model: ${latestModel}`,
          });
          costUsd = 0;
        } else {
          costUsd = computeCost(key, inputTokens ?? 0, outputTokens ?? 0);
        }
      }
      const completeEvent: AgentEvent = {
        type: 'complete',
        timestamp: ts,
        result,
        ...(inputTokens !== undefined && { totalInputTokens: inputTokens }),
        ...(outputTokens !== undefined && { totalOutputTokens: outputTokens }),
        ...(costUsd !== undefined && { costUsd }),
      };
      yield completeEvent;
      latestUsage = undefined;
      continue;
    }

    const mapped = mapEvent(env, podId, logger);
    if (mapped) yield mapped;
  }
}

export const CodexStreamParser = { parse, mapEvent } as const;

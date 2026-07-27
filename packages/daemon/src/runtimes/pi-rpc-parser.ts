import type { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import {
  type ProviderErrorEvidence,
  classifyProviderError,
  classifySettledPiProviderError,
  sanitizeProviderMessage,
} from './provider-error-classifier.js';

export interface PiRpcStats {
  events: number;
  nonStatusEvents: number;
  sawTerminal: boolean;
  sessionId?: string;
}
export interface PiRpcParseOptions {
  podId: string;
  logger: Logger;
  stats?: PiRpcStats;
  expectedResponseIds?: Set<string | number>;
}

type PiRpcRecord = Record<string, unknown>;
interface PiNativeRetryState {
  pendingError: ProviderErrorEvidence | null;
  phase: 'idle' | 'announced' | 'retrying' | 'failed';
  maxAttempts: number | null;
  lastAttempt: number;
  finalAgentEndObserved: boolean;
}
interface PiToolExecutionState {
  completedCallIds: Set<string>;
  pendingCalls: Map<
    string,
    {
      tool: string;
      args: Record<string, unknown>;
    }
  >;
}

const MAX_TEXT = 4_000;
const MAX_OUTPUT = 2_000;

export const PiRpcParser = { parse: parsePiRpc };

export async function* parsePiRpc(
  stream: Readable,
  options: PiRpcParseOptions,
): AsyncIterable<AgentEvent> {
  let buffer = '';
  const retryState: PiNativeRetryState = {
    pendingError: null,
    phase: 'idle',
    maxAttempts: null,
    lastAttempt: 0,
    finalAgentEndObserved: false,
  };
  const toolState: PiToolExecutionState = {
    completedCallIds: new Set(),
    pendingCalls: new Map(),
  };
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    let lf = buffer.indexOf('\n');
    while (lf !== -1) {
      const line = buffer.slice(0, lf);
      buffer = buffer.slice(lf + 1);
      yield* parseLine(line, options, retryState, toolState);
      lf = buffer.indexOf('\n');
    }
  }

  if (buffer.length > 0) {
    yield malformedEvent('Pi RPC stream ended with a partial JSON record', options);
  }
}

function* parseLine(
  line: string,
  options: PiRpcParseOptions,
  retryState: PiNativeRetryState,
  toolState: PiToolExecutionState,
): Iterable<AgentEvent> {
  if (line.endsWith('\r')) {
    yield malformedEvent('Pi RPC record used CRLF framing; expected LF-only JSON records', options);
    return;
  }
  if (!line.trim()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    yield malformedEvent('Pi RPC stream emitted malformed JSON', options);
    return;
  }

  if (!isObject(parsed)) {
    yield malformedEvent('Pi RPC stream emitted a non-object record', options);
    return;
  }

  const event = mapRecord(parsed, options, retryState, toolState);
  if (!event) return;
  recordStats(event, options.stats);
  yield event;
}

function mapRecord(
  record: PiRpcRecord,
  options: PiRpcParseOptions,
  retryState: PiNativeRetryState,
  toolState: PiToolExecutionState,
): AgentEvent | null {
  const kind = stringField(record, 'type') ?? stringField(record, 'event');
  const ts = stringField(record, 'timestamp') ?? new Date().toISOString();

  if (
    kind === 'tool_execution_start' ||
    kind === 'tool_execution_update' ||
    kind === 'tool_execution_end'
  ) {
    return mapNativeToolExecution(kind, record, ts, options, toolState);
  }

  if (kind === 'message_end') {
    const message = objectField(record, 'message');
    if (message?.stopReason === 'error' && typeof message.errorMessage === 'string') {
      acceptPiRetryEvidence(retryState, parsePiNativeError(message.errorMessage));
    } else if (message?.role === 'assistant') {
      retryState.pendingError = null;
      retryState.phase = 'idle';
      retryState.maxAttempts = null;
      retryState.lastAttempt = 0;
      retryState.finalAgentEndObserved = false;
    }
    return null;
  }

  if (kind === 'agent_end') {
    const nativeError = lastAssistantError(record.messages);
    let consistent = true;
    if (nativeError) {
      consistent = acceptPiRetryEvidence(retryState, parsePiNativeError(nativeError));
    } else if (record.willRetry !== true) {
      retryState.pendingError = null;
      retryState.phase = 'idle';
      retryState.maxAttempts = null;
      retryState.lastAttempt = 0;
      retryState.finalAgentEndObserved = false;
    }
    if (record.willRetry === true && consistent) {
      retryState.phase = 'announced';
      retryState.maxAttempts = null;
      retryState.lastAttempt = 0;
      retryState.finalAgentEndObserved = false;
      return { type: 'status', timestamp: ts, message: 'Pi provider retry pending' };
    }
    if (
      record.willRetry === false &&
      consistent &&
      nativeError &&
      retryState.phase === 'retrying' &&
      retryState.lastAttempt === retryState.maxAttempts
    ) {
      retryState.finalAgentEndObserved = true;
    }
    return null;
  }

  if (kind === 'auto_retry_start') {
    const errorMessage = stringField(record, 'errorMessage');
    const consistent =
      errorMessage !== undefined &&
      acceptPiRetryEvidence(retryState, parsePiNativeError(errorMessage));
    const attempt = positiveInteger(record.attempt);
    const maxAttempts = positiveInteger(record.maxAttempts);
    const firstAttempt = retryState.phase === 'announced' && attempt === 1;
    const nextAttempt =
      retryState.phase === 'retrying' &&
      attempt !== null &&
      attempt === retryState.lastAttempt + 1 &&
      maxAttempts === retryState.maxAttempts;
    const expected =
      consistent &&
      (firstAttempt || nextAttempt) &&
      attempt !== null &&
      maxAttempts !== null &&
      attempt <= maxAttempts;
    retryState.phase = expected ? 'retrying' : 'idle';
    retryState.maxAttempts = expected ? maxAttempts : null;
    retryState.lastAttempt = expected ? attempt : 0;
    if (expected) retryState.finalAgentEndObserved = false;
    const classification = classifyProviderError(
      'pi',
      retryState.pendingError ?? { message: 'Pi provider retry started' },
    );
    return {
      type: 'error',
      timestamp: ts,
      message: classification.sanitizedMessage,
      fatal: false,
      classification,
    };
  }

  if (kind === 'auto_retry_end') {
    if (record.success === true && retryState.phase === 'retrying') {
      retryState.pendingError = null;
      retryState.phase = 'idle';
      retryState.maxAttempts = null;
      retryState.lastAttempt = 0;
      retryState.finalAgentEndObserved = false;
      return { type: 'status', timestamp: ts, message: 'Pi provider retry succeeded' };
    }
    const finalError = stringField(record, 'finalError');
    const finalAttempt = positiveInteger(record.attempt);
    const consistent =
      finalError !== undefined && acceptPiRetryEvidence(retryState, parsePiNativeError(finalError));
    const validFailure =
      record.success === false &&
      retryState.phase === 'retrying' &&
      consistent &&
      finalAttempt !== null &&
      finalAttempt === retryState.maxAttempts &&
      retryState.lastAttempt === retryState.maxAttempts &&
      retryState.finalAgentEndObserved;
    retryState.phase = validFailure ? 'failed' : 'idle';
    if (!validFailure) retryState.maxAttempts = null;
    if (!validFailure) retryState.lastAttempt = 0;
    if (!validFailure) retryState.finalAgentEndObserved = false;
    return {
      type: 'status',
      timestamp: ts,
      message: validFailure
        ? 'Pi provider retries exhausted; awaiting agent settlement'
        : 'Pi emitted an out-of-sequence retry completion',
    };
  }

  if (kind === 'agent_settled') {
    if (!retryState.pendingError) return null;
    const classification =
      retryState.phase === 'failed'
        ? classifySettledPiProviderError(retryState.pendingError)
        : classifyProviderError('pi', retryState.pendingError);
    retryState.pendingError = null;
    retryState.phase = 'idle';
    retryState.maxAttempts = null;
    retryState.lastAttempt = 0;
    retryState.finalAgentEndObserved = false;
    return {
      type: 'error',
      timestamp: ts,
      message: classification.sanitizedMessage,
      fatal: true,
      classification,
    };
  }

  if (kind === 'response') {
    if (
      options.expectedResponseIds &&
      !options.expectedResponseIds.has(record.id as string | number)
    ) {
      return {
        type: 'error',
        timestamp: ts,
        message: `Pi RPC response did not match an issued command id: ${String(record.id)}`,
        fatal: true,
      };
    }
    options.expectedResponseIds?.delete(record.id as string | number);
    if (isObject(record.error)) {
      const message = stringField(record.error, 'message') ?? 'Pi RPC command failed';
      const classification = classifyProviderError('pi', {
        message,
        code: record.error.code,
        status: record.error.status,
        retryAfter: record.error.retryAfter ?? record.error.retry_after,
      });
      return {
        type: 'error',
        timestamp: ts,
        message: classification.sanitizedMessage,
        fatal: true,
        classification,
      };
    }
    const result = isObject(record.result) ? record.result : {};
    const sessionId = stringField(result, 'sessionId') ?? stringField(record, 'sessionId');
    recordSessionId(sessionId, options);
    return {
      type: 'status',
      timestamp: ts,
      message: `Pi accepted command ${String(record.id ?? '<unknown>')}`,
      ...(sessionId && { sessionId }),
    };
  }

  if (kind === 'session' || kind === 'session_ready') {
    const sessionId = stringField(record, 'sessionId') ?? stringField(record, 'session_id');
    recordSessionId(sessionId, options);
    return {
      type: 'status',
      timestamp: ts,
      message: sessionId ? `Pi session ready (${sessionId})` : 'Pi session ready',
      ...(sessionId && { sessionId }),
    };
  }

  if (kind === 'status') {
    const sessionId = stringField(record, 'sessionId') ?? stringField(record, 'session_id');
    recordSessionId(sessionId, options);
    return {
      type: 'status',
      timestamp: ts,
      message: truncate(stringField(record, 'message') ?? 'Pi status', MAX_TEXT),
      ...(sessionId && { sessionId }),
    };
  }

  if (kind === 'text' || kind === 'message') {
    return {
      type: 'reasoning',
      timestamp: ts,
      text: truncate(stringField(record, 'text') ?? stringField(record, 'message') ?? '', MAX_TEXT),
    };
  }

  if (kind === 'tool' || kind === 'tool_use') {
    return {
      type: 'tool_use',
      timestamp: ts,
      tool: stringField(record, 'tool') ?? stringField(record, 'name') ?? 'pi_tool',
      input: objectField(record, 'input') ?? objectField(record, 'arguments') ?? {},
      ...(record.output !== undefined && { output: truncate(String(record.output), MAX_OUTPUT) }),
    };
  }

  if (kind === 'error') {
    const message = truncate(stringField(record, 'message') ?? 'Pi runtime error', MAX_TEXT);
    const fatal = record.fatal !== false;
    const classification = fatal
      ? classifyProviderError('pi', {
          message,
          code: record.code,
          status: record.status,
          retryAfter: record.retryAfter ?? record.retry_after,
        })
      : null;
    return {
      type: 'error',
      timestamp: ts,
      message: classification?.sanitizedMessage ?? sanitizeProviderMessage(message),
      fatal,
      ...(classification && { classification }),
    };
  }

  if (kind === 'complete' || kind === 'completion' || kind === 'done') {
    return {
      type: 'complete',
      timestamp: ts,
      result: truncate(
        stringField(record, 'result') ?? stringField(record, 'summary') ?? 'Pi task complete',
        MAX_TEXT,
      ),
      ...(numberField(record, 'totalInputTokens') !== undefined && {
        totalInputTokens: numberField(record, 'totalInputTokens'),
      }),
      ...(numberField(record, 'totalOutputTokens') !== undefined && {
        totalOutputTokens: numberField(record, 'totalOutputTokens'),
      }),
      ...(numberField(record, 'costUsd') !== undefined && {
        costUsd: numberField(record, 'costUsd'),
      }),
    };
  }

  options.logger.debug(
    { component: 'pi-rpc-parser', podId: options.podId, recordType: kind ?? '<missing>' },
    'Ignoring unknown Pi RPC record',
  );
  return null;
}

function mapNativeToolExecution(
  kind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end',
  record: PiRpcRecord,
  timestamp: string,
  options: PiRpcParseOptions,
  state: PiToolExecutionState,
): AgentEvent | null {
  if (kind === 'tool_execution_update') return null;

  const callId =
    stringField(record, 'toolCallId') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'callId') ??
    stringField(record, 'call_id');
  if (!callId) {
    return {
      type: 'error',
      timestamp,
      message: `Pi RPC emitted malformed ${kind} record`,
      fatal: false,
    };
  }
  if (state.completedCallIds.has(callId)) return null;

  const tool = stringField(record, 'toolName') ?? stringField(record, 'tool_name');
  if (!tool) {
    return {
      type: 'error',
      timestamp,
      message: `Pi RPC emitted malformed ${kind} record`,
      fatal: false,
    };
  }
  if (!['read', 'edit', 'write'].includes(tool)) return null;

  const args = objectField(record, 'args') ?? objectField(record, 'arguments');
  if (kind === 'tool_execution_start') {
    if (!args) {
      return {
        type: 'error',
        timestamp,
        message: `Pi RPC emitted malformed ${kind} record`,
        fatal: false,
      };
    }
    state.pendingCalls.set(callId, { tool, args });
    return null;
  }

  const pending = state.pendingCalls.get(callId);
  state.pendingCalls.delete(callId);
  state.completedCallIds.add(callId);
  if (pending && pending.tool !== tool) {
    return {
      type: 'error',
      timestamp,
      message: `Pi RPC emitted malformed ${kind} record`,
      fatal: false,
    };
  }
  const retainedArgs = pending?.args ?? args;
  if (!retainedArgs) {
    return {
      type: 'error',
      timestamp,
      message: `Pi RPC emitted malformed ${kind} record`,
      fatal: false,
    };
  }
  // Pi emits the attempted call at start, before its result is known. Only an
  // explicit successful end record is trustworthy evidence that a read or
  // mutation actually happened.
  if (record.isError !== false) return null;

  const output =
    record.result !== undefined
      ? truncate(
          typeof record.result === 'string' ? record.result : JSON.stringify(record.result),
          MAX_OUTPUT,
        )
      : undefined;
  return {
    type: 'tool_use',
    timestamp,
    tool,
    input: { ...retainedArgs, call_id: callId },
    ...(output !== undefined && { output }),
  };
}

function malformedEvent(message: string, options: PiRpcParseOptions): AgentEvent {
  const event: AgentEvent = {
    type: 'error',
    timestamp: new Date().toISOString(),
    message,
    fatal: false,
  };
  recordStats(event, options.stats);
  return event;
}

function recordStats(event: AgentEvent, stats: PiRpcStats | undefined): void {
  if (!stats) return;
  stats.events += 1;
  if (event.type !== 'status') stats.nonStatusEvents += 1;
  if (event.type === 'complete' || (event.type === 'error' && event.fatal)) {
    stats.sawTerminal = true;
  }
}

function recordSessionId(sessionId: string | undefined, options: PiRpcParseOptions): void {
  if (sessionId && options.stats) {
    options.stats.sessionId = sessionId;
  }
}

function isObject(value: unknown): value is PiRpcRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: PiRpcRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: PiRpcRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function acceptPiRetryEvidence(
  state: PiNativeRetryState,
  candidate: ProviderErrorEvidence,
): boolean {
  if (!state.pendingError) {
    state.pendingError = candidate;
    return true;
  }
  if (samePiRetryEvidence(state.pendingError, candidate)) return true;
  state.pendingError = candidate;
  state.phase = 'idle';
  state.maxAttempts = null;
  state.lastAttempt = 0;
  state.finalAgentEndObserved = false;
  return false;
}

function samePiRetryEvidence(left: ProviderErrorEvidence, right: ProviderErrorEvidence): boolean {
  return left.message === right.message && left.code === right.code && left.status === right.status;
}

function objectField(record: PiRpcRecord, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return isObject(value) ? value : undefined;
}

function parsePiNativeError(raw: string): ProviderErrorEvidence {
  const trimmed = raw.trim();
  const match =
    /^(?:(\d{3})\s+)?(usage_limit_reached|quota_exceeded|insufficient_quota): (Provider usage limit reached|Provider quota exhausted)$/i.exec(
      trimmed,
    );
  if (!match) return { message: trimmed };
  return {
    message: match[3],
    code: match[2],
    ...(match[1] && { status: Number(match[1]) }),
  };
}

function lastAssistantError(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      isObject(message) &&
      message.role === 'assistant' &&
      message.stopReason === 'error' &&
      typeof message.errorMessage === 'string'
    ) {
      return message.errorMessage;
    }
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

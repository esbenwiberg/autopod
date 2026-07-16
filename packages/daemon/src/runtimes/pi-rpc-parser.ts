import type { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';

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

const MAX_TEXT = 4_000;
const MAX_OUTPUT = 2_000;

export const PiRpcParser = { parse: parsePiRpc };

export async function* parsePiRpc(
  stream: Readable,
  options: PiRpcParseOptions,
): AsyncIterable<AgentEvent> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    let lf = buffer.indexOf('\n');
    while (lf !== -1) {
      const line = buffer.slice(0, lf);
      buffer = buffer.slice(lf + 1);
      yield* parseLine(line, options);
      lf = buffer.indexOf('\n');
    }
  }

  if (buffer.length > 0) {
    yield malformedEvent('Pi RPC stream ended with a partial JSON record', options);
  }
}

function* parseLine(line: string, options: PiRpcParseOptions): Iterable<AgentEvent> {
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

  const event = mapRecord(parsed, options);
  if (!event) return;
  recordStats(event, options.stats);
  yield event;
}

function mapRecord(record: PiRpcRecord, options: PiRpcParseOptions): AgentEvent | null {
  const kind = stringField(record, 'type') ?? stringField(record, 'event');
  const ts = stringField(record, 'timestamp') ?? new Date().toISOString();

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
      return {
        type: 'error',
        timestamp: ts,
        message: stringField(record.error, 'message') ?? 'Pi RPC command failed',
        fatal: true,
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
    return {
      type: 'error',
      timestamp: ts,
      message: truncate(stringField(record, 'message') ?? 'Pi runtime error', MAX_TEXT),
      fatal: record.fatal !== false,
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

function objectField(record: PiRpcRecord, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return isObject(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

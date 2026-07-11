import {
  assertSuccess,
  createInitializeRequest,
  createInitializedNotification,
  createToolsCallRequest,
  createToolsListRequest,
  parseCallToolResult,
  parseHttpJsonRpcPayload,
  parseToolListResult,
  sanitizeTransportDetail,
} from './protocol.js';
import {
  type JsonObject,
  type McpCallToolResult,
  type McpClient,
  McpTransportError,
} from './types.js';

export class HttpMcpClient implements McpClient {
  readonly serverName: string;

  private nextId = 1;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly maxResultBytes: number | undefined;
  private sessionId?: string;

  constructor(config: {
    serverName: string;
    url: string;
    headers?: Record<string, string>;
    maxResultBytes?: number;
  }) {
    this.serverName = config.serverName;
    this.url = config.url;
    this.headers = config.headers ?? {};
    this.maxResultBytes = config.maxResultBytes;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    assertSuccess(await this.post(createInitializeRequest(this.nextId++), signal));
    await this.post(createInitializedNotification(), signal);
  }

  async listTools(signal?: AbortSignal) {
    const result = assertSuccess(await this.post(createToolsListRequest(this.nextId++), signal));
    return parseToolListResult(result);
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpCallToolResult> {
    const result = assertSuccess(
      await this.post(createToolsCallRequest(this.nextId++, name, args), signal),
    );
    return parseCallToolResult(result, this.maxResultBytes);
  }

  async close(): Promise<void> {
    return;
  }

  private async post(payload: unknown, signal?: AbortSignal) {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal,
      });
      const text = await response.text();
      this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      if (text.trim().length === 0) {
        return { jsonrpc: '2.0' as const, id: 0, result: {} };
      }
      const expectedId = isJsonRpcRequest(payload) ? payload.id : undefined;
      return parseHttpJsonRpcPayload(text, expectedId);
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = sanitizeTransportDetail(error);
      throw new McpTransportError(
        `MCP HTTP transport failed for ${this.serverName}: ${detail}`,
        this.serverName,
        detail,
      );
    }
  }
}

function isJsonRpcRequest(payload: unknown): payload is { id: string | number } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'id' in payload &&
    (typeof payload.id === 'string' || typeof payload.id === 'number')
  );
}

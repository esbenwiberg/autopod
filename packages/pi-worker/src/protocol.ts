import type {
  JsonObject,
  JsonRpcFailure,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpCallToolResult,
  McpToolDefinition,
} from './types.js';

const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

export function createInitializeRequest(id: string | number): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: '@autopod/pi-worker',
        version: '0.0.1',
      },
    },
  };
}

export function createInitializedNotification(): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
}

export function createToolsListRequest(id: string | number): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  };
}

export function createToolsCallRequest(
  id: string | number,
  name: string,
  args: JsonObject,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  };
}

export function createCancelledNotification(
  requestId: string | number,
  reason: string,
): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: {
      requestId,
      reason,
    },
  };
}

export function parseJsonRpcResponse(value: unknown): JsonRpcResponse {
  if (!isObject(value) || value.jsonrpc !== '2.0' || !('id' in value)) {
    throw new Error('Invalid MCP JSON-RPC response');
  }
  if ('error' in value) {
    const error = value.error;
    if (!isObject(error) || typeof error.message !== 'string') {
      throw new Error('Invalid MCP JSON-RPC error response');
    }
    return value as JsonRpcFailure;
  }
  if (!('result' in value)) {
    throw new Error('Invalid MCP JSON-RPC success response');
  }
  return value as JsonRpcSuccess;
}

export function assertSuccess(response: JsonRpcResponse): unknown {
  if ('error' in response) {
    throw new Error(response.error.message);
  }
  return response.result;
}

export function parseToolListResult(result: unknown): McpToolDefinition[] {
  if (!isObject(result) || !Array.isArray(result.tools)) {
    throw new Error('MCP tools/list result did not contain a tools array');
  }
  return result.tools.map((tool) => {
    if (!isObject(tool) || typeof tool.name !== 'string') {
      throw new Error('MCP tools/list returned a tool without a string name');
    }
    if (tool.inputSchema !== undefined && !isObject(tool.inputSchema)) {
      throw new Error(`MCP tool ${tool.name} has an unsupported input schema`);
    }
    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema as JsonObject | undefined,
    };
  });
}

export function parseCallToolResult(
  result: unknown,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
): McpCallToolResult {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > maxResultBytes) {
    throw new Error(`MCP tool result exceeded ${maxResultBytes} bytes`);
  }
  if (!isObject(result)) {
    throw new Error('MCP tools/call result was not an object');
  }
  return result as McpCallToolResult;
}

export function parseHttpJsonRpcPayload(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const data = parseSseData(trimmed);
    return parseJsonRpcResponse(JSON.parse(data));
  }
  return parseJsonRpcResponse(JSON.parse(trimmed));
}

export function sanitizeTransportDetail(detail: unknown): string {
  const raw = detail instanceof Error ? detail.message : String(detail);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function parseSseData(payload: string): string {
  const lines = payload.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  if (dataLines.length === 0) {
    throw new Error('MCP HTTP response contained SSE without data');
  }
  return dataLines.join('\n');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

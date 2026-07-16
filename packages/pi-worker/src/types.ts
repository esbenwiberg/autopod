export const AUTOPOD_PI_WORKER_PACKAGE = '@autopod/pi-worker';
export const AUTOPOD_PI_WORKER_ENTRYPOINT = '@autopod/pi-worker';
export const AUTOPOD_PI_EXTENSION_ID = 'autopod-managed-mcp-worker';

export const AUTOPOD_PI_MANAGED_STARTUP = {
  packageName: AUTOPOD_PI_WORKER_PACKAGE,
  extensionId: AUTOPOD_PI_EXTENSION_ID,
  entrypoint: AUTOPOD_PI_WORKER_ENTRYPOINT,
  loadProjectExtensions: false,
  allowExecutableProjectResources: false,
} as const;

export interface PiWorkerConfig {
  mcpServers: PiWorkerMcpServerConfig[];
  requiredServerName: string;
  toolNamePrefix?: string;
  maxResultBytes?: number;
}

export type PiWorkerMcpServerConfig = PiWorkerHttpMcpServerConfig | PiWorkerStdioMcpServerConfig;

export interface PiWorkerHttpMcpServerConfig {
  type?: 'http';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface PiWorkerStdioMcpServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PiToolRegistry {
  registerTool(tool: PiNativeTool): void | Promise<void>;
}

export interface PiNativeTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  call(args: JsonObject, options?: PiToolCallOptions): Promise<McpCallToolResult>;
}

export interface PiToolCallOptions {
  signal?: AbortSignal;
}

export interface RegisteredMcpTool {
  serverName: string;
  mcpName: string;
  piName: string;
  description?: string;
  inputSchema: JsonObject;
  call(args: JsonObject, signal?: AbortSignal): Promise<McpCallToolResult>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpCallToolResult {
  content?: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

export interface McpClient {
  readonly serverName: string;
  initialize(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export type JsonObject = Record<string, unknown>;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class PiWorkerStartupError extends Error {
  constructor(
    message: string,
    readonly code: 'required_server_missing' | 'server_initialization_failed' | 'tool_collision',
  ) {
    super(message);
    this.name = 'PiWorkerStartupError';
  }
}

export class McpTransportError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
    readonly causeDetail?: string,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

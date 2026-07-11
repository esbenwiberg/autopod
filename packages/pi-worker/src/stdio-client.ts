import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type Interface, createInterface } from 'node:readline';
import {
  assertSuccess,
  createCancelledNotification,
  createInitializeRequest,
  createInitializedNotification,
  createToolsCallRequest,
  createToolsListRequest,
  parseCallToolResult,
  parseJsonRpcResponse,
  parseToolListResult,
  sanitizeTransportDetail,
} from './protocol.js';
import {
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolResult,
  type McpClient,
  McpTransportError,
} from './types.js';

interface PendingRequest {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  abort?: () => void;
}

export class StdioMcpClient implements McpClient {
  readonly serverName: string;

  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly maxResultBytes: number | undefined;
  private nextId = 1;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private readonly pending = new Map<string | number, PendingRequest>();

  constructor(config: {
    serverName: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    maxResultBytes?: number;
  }) {
    this.serverName = config.serverName;
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env;
    this.maxResultBytes = config.maxResultBytes;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    this.ensureStarted();
    assertSuccess(await this.request(createInitializeRequest(this.nextId++), signal));
    this.notify(createInitializedNotification());
  }

  async listTools(signal?: AbortSignal) {
    const result = assertSuccess(await this.request(createToolsListRequest(this.nextId++), signal));
    return parseToolListResult(result);
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpCallToolResult> {
    const result = assertSuccess(
      await this.request(createToolsCallRequest(this.nextId++, name, args), signal),
    );
    return parseCallToolResult(result, this.maxResultBytes);
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`MCP stdio server ${this.serverName} closed`));
    }
    this.pending.clear();
    this.lines?.close();
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }

  private ensureStarted(): void {
    if (this.child) return;
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.failAll(new Error(`exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`));
    });
  }

  private request(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    this.ensureStarted();
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const onAbort = () => {
        this.notify(createCancelledNotification(request.id, 'Pi tool call aborted'));
        this.pending.delete(request.id);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: (response) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        reject: (error) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(this.transportError(error));
        },
      });
      try {
        this.write(request);
      } catch (error) {
        this.pending.delete(request.id);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(this.transportError(error));
      }
    });
  }

  private notify(notification: JsonRpcNotification): void {
    try {
      this.write(notification);
    } catch {
      // Notification failures surface on the next request through the process error path.
    }
  }

  private write(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.child) throw new Error('stdio server was not started');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = parseJsonRpcResponse(JSON.parse(line));
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private transportError(error: unknown): McpTransportError {
    const detail = sanitizeTransportDetail(error);
    return new McpTransportError(
      `MCP stdio transport failed for ${this.serverName}: ${detail}`,
      this.serverName,
      detail,
    );
  }
}

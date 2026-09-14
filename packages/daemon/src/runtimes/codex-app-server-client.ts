import { StringDecoder } from 'node:string_decoder';
import type { StreamingExecResult } from '../interfaces/container-manager.js';

export interface CodexNotification {
  method: string;
  params: unknown;
}
export class CodexRpcError extends Error {
  constructor(readonly code: string) {
    super(`Codex app-server ${code}; reconcile native state before retrying`);
  }
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export async function terminateCodexAppServer(process: StreamingExecResult): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await process.kill();
        await process.exitCode;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodexRpcError('TERMINATION_UNCONFIRMED')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded NDJSON RPC for one pod-owned process. Transport uncertainty never retries a mutation. */
export class CodexAppServerClient {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private notifications: Array<{ value: CodexNotification; bytes: number }> = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private failed: Error | null = null;
  private ended = false;
  private writes = Promise.resolve();

  constructor(
    private readonly process: StreamingExecResult,
    private readonly timeoutMs = 15_000,
  ) {
    if (!process.stdin) throw new CodexRpcError('STDIN_UNAVAILABLE');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CodexRpcError('INVALID_DEADLINE');
    void this.read().catch(() => this.fail(new CodexRpcError('INVALID_PROTOCOL')));
    // Drain diagnostics without exposing credential-bearing subprocess messages.
    void (async () => {
      for await (const _ of process.stderr) {
        /* drained */
      }
    })().catch(() => this.fail(new CodexRpcError('STDERR_TRANSPORT_FAILED')));
    void process.exitCode.then(
      () => {
        this.ended = true;
        if (this.pending.size) this.fail(new CodexRpcError('EXIT_BEFORE_RESPONSE'));
        this.wake?.();
      },
      () => this.fail(new CodexRpcError('EXIT_UNCONFIRMED')),
    );
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) throw this.failed;
    if (this.ended) throw new CodexRpcError('PROCESS_CLOSED');
    if (this.pending.size >= 128) throw new CodexRpcError('REQUEST_LIMIT');
    const id = ++this.sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new CodexRpcError('RESPONSE_UNCERTAIN')),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
    });
    // Install the observer before writing: write errors can reject the response synchronously.
    result.catch(() => {});
    void this.write({ id, method, params }).catch(() =>
      this.fail(new CodexRpcError('WRITE_UNCERTAIN')),
    );
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async *events(): AsyncIterable<CodexNotification> {
    while (true) {
      if (this.failed) throw this.failed;
      const next = this.notifications.shift();
      if (next) {
        this.queuedBytes -= next.bytes;
        yield next.value;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  async close(): Promise<void> {
    this.fail(new CodexRpcError('PROCESS_CLOSED'));
    await terminateCodexAppServer(this.process);
  }

  private fail(error: Error): void {
    this.failed ??= error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(this.failed);
    }
    this.pending.clear();
    this.wake?.();
  }

  private async write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new CodexRpcError('REQUEST_TOO_LARGE');
    this.writes = this.writes.then(async () => {
      if (this.failed) throw this.failed;
      if (this.ended) throw new CodexRpcError('PROCESS_CLOSED');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new CodexRpcError('WRITE_UNCERTAIN')),
          this.timeoutMs,
        );
        this.process.stdin?.write(line, (error) => {
          clearTimeout(timer);
          if (error) reject(new CodexRpcError('WRITE_UNCERTAIN'));
          else resolve();
        });
      });
    });
    try {
      await this.writes;
    } catch (error) {
      this.fail(error instanceof Error ? error : new CodexRpcError('WRITE_UNCERTAIN'));
      throw this.failed;
    }
  }

  private async read(): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    for await (const chunk of this.process.stdout) {
      if (Buffer.byteLength(chunk) > MAX_QUEUED_BYTES) throw new CodexRpcError('CHUNK_TOO_LARGE');
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new CodexRpcError('FRAME_TOO_LARGE');
        if (line.trim()) await this.receive(JSON.parse(line), Buffer.byteLength(line));
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new CodexRpcError('FRAME_TOO_LARGE');
    }
    buffer += decoder.end();
    if (buffer.trim()) throw new CodexRpcError('TRUNCATED_FRAME');
    if (!this.ended) this.fail(new CodexRpcError('STREAM_CLOSED'));
  }

  private async receive(value: unknown, bytes: number): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CodexRpcError('INVALID_FRAME');
    const message = value as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if ('id' in message) {
        // Permissions and unexpected interactive requests cannot widen the pod's admitted authority.
        if (typeof message.id !== 'string' && typeof message.id !== 'number')
          throw new CodexRpcError('INVALID_ID');
        await this.write({
          id: message.id,
          error: {
            code: -32601,
            message: 'Interactive requests are unavailable; use AutoPod scoped tools.',
          },
        });
        return;
      }
      if (this.notifications.length >= 1024 || this.queuedBytes + bytes > MAX_QUEUED_BYTES)
        throw new CodexRpcError('NOTIFICATION_OVERFLOW');
      this.notifications.push({ value: { method: message.method, params: message.params }, bytes });
      this.queuedBytes += bytes;
      this.wake?.();
      return;
    }
    if (typeof message.id !== 'number') throw new CodexRpcError('INVALID_ID');
    const pending = this.pending.get(message.id);
    if (!pending) throw new CodexRpcError('UNEXPECTED_RESPONSE');
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(new CodexRpcError('REQUEST_REJECTED'));
    else if ('result' in message) pending.resolve(message.result);
    else {
      pending.reject(new CodexRpcError('INVALID_RESPONSE'));
      throw new CodexRpcError('INVALID_RESPONSE');
    }
  }
}

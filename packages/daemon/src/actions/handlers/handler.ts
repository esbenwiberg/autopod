import type { ActionDefinition } from '@autopod/shared';
import type { Logger } from 'pino';
import type { SsrfCheckResult } from '../../api/ssrf-guard.js';
import type { PinnedHttpTransport } from '../pinned-http-transport.js';

/**
 * Common interface for all action handlers.
 * Each handler knows how to execute actions for its backend (GitHub, ADO, Azure, HTTP).
 */
export interface ActionHandler {
  readonly handlerType: string;
  execute(
    action: ActionDefinition,
    params: Record<string, unknown>,
    context?: ActionHandlerContext,
  ): Promise<unknown>;
}

/** Per-call context forwarded by the action-engine. Handlers that don't need
 *  it simply ignore the argument. */
export interface ActionHandlerContext {
  podId: string;
  /**
   * Handler-specific data captured at approval time (populated by the MCP layer
   * after a human approves the action). Used by the deploy handler to verify
   * the script hash has not changed since the reviewer approved it.
   */
  approvalContext?: Record<string, unknown>;
}

export interface HandlerConfig {
  logger: Logger;
  getSecret: (ref: string) => string | undefined;
  /** Canonical daemon-level GitHub credential source. */
  getGitHubToken?: () => Promise<string>;
  /** Canonical daemon-level Azure DevOps Entra credential source. */
  getAzureDevOpsToken?: () => Promise<string>;
  /**
   * SSRF guard hook. Returns `{ ok: false, reason }` to abort an HTTP call.
   * Defaults to `assertPublicUrl` from `api/ssrf-guard.ts`. Override in tests
   * that hit a localhost mock server.
   */
  ssrfGuard?: (url: string) => Promise<SsrfCheckResult>;
  /** Trusted dependency injection only; never selected from request/profile input. */
  httpTransport?: PinnedHttpTransport;
}

/**
 * Extract fields from a response object based on a whitelist.
 * Supports dot-notation, including array traversal:
 *   'fields.System.Title' on { fields: { 'System.Title': 'x' } } → 'x'
 *   'comments.content'    on { comments: [{ content: 'a' }, { content: 'b' }] } → ['a', 'b']
 */
export function pickFields(obj: unknown, fields: string[]): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getNestedValue(obj as Record<string, unknown>, field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function getNestedValue(obj: Record<string, unknown> | unknown[], path: string): unknown {
  // Array at the current level: project the path across each element.
  // Skips elements where the path resolves to undefined so the output array
  // doesn't include holes the agent has to defensively guard against.
  if (Array.isArray(obj)) {
    const projected: unknown[] = [];
    for (const item of obj) {
      if (item === null || typeof item !== 'object') continue;
      const v = getNestedValue(item as Record<string, unknown>, path);
      if (v !== undefined) projected.push(v);
    }
    return projected;
  }

  // Try exact key first (handles keys with dots like 'System.Title')
  if (path in obj) return obj[path];

  // Then try progressive splitting: for 'a.b.c', try obj['a']['b.c'], obj['a']['b']['c']
  const dotIndex = path.indexOf('.');
  if (dotIndex === -1) return obj[path];

  const head = path.slice(0, dotIndex);
  const tail = path.slice(dotIndex + 1);
  const child = obj[head];

  if (child === null || child === undefined || typeof child !== 'object') {
    return undefined;
  }

  return getNestedValue(child as Record<string, unknown> | unknown[], tail);
}

/**
 * Apply field whitelist to an array of results.
 */
export function pickFieldsArray(items: unknown[], fields: string[]): Record<string, unknown>[] {
  return items.map((item) => pickFields(item, fields));
}

/**
 * Resolve a JSONPath-like result path on an object.
 * e.g. 'data.results' on { data: { results: [...] } } → [...]
 */
export function resolveResultPath(obj: unknown, resultPath: string | undefined): unknown {
  if (!resultPath) return obj;
  return getNestedValue(obj as Record<string, unknown>, resultPath);
}

const DEFAULT_TIMEOUT = 15_000;
/** Limit decoded bytes, including errors and chunked responses. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function responseTooLarge(): Error {
  return new Error(
    `Response too large (limit ${MAX_RESPONSE_BYTES} bytes). Use more specific query parameters to reduce results.`,
  );
}

/** Consume at most the limit, cancelling the upstream stream on every failure. */
async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    signal?.throwIfAborted();
    return new Uint8Array();
  }
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw responseTooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw responseTooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/**
 * Resolve only after the bounded body is received. Every caller, including
 * error/text consumers, gets the same full-request deadline and byte limit.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeout?: number },
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, signal: callerSignal, ...requestInit } = init;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('Invalid HTTP action timeout');
  }
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    signal.throwIfAborted();
    const response = await withAbort(
      transport(url, {
        ...requestInit,
        headers: {
          'Accept-Language': 'en-US',
          ...init.headers,
        },
        signal,
      }),
      signal,
      (late) => {
        void late.body?.cancel().catch(() => {});
      },
    );
    const bytes = await readBoundedBody(response, signal);
    const buffered = new Response(response.body === null ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Preserve useful transport metadata without exposing an unbounded stream.
    Object.defineProperties(buffered, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return buffered;
  } finally {
    clearTimeout(timer);
  }
}

/** Also enforce streaming byte bounds for responses supplied by other callers. */
export async function readSafeJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedBody(response);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Abort pending DNS/transport work promptly; clean up a response arriving late. */
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work
      .then((value) => {
        if (signal.aborted) onLate?.(value);
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

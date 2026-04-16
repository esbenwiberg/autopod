import type { ActionDefinition } from '@autopod/shared';
import type { Logger } from 'pino';

/**
 * Common interface for all action handlers.
 * Each handler knows how to execute actions for its backend (GitHub, ADO, Azure, HTTP).
 */
export interface ActionHandler {
  readonly handlerType: string;
  execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown>;
}

export interface HandlerConfig {
  logger: Logger;
  getSecret: (ref: string) => string | undefined;
}

/**
 * Extract fields from a response object based on a whitelist.
 * Supports dot-notation (e.g. 'fields.System.Title').
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

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
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

  return getNestedValue(child as Record<string, unknown>, tail);
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
/** Reject responses larger than this to prevent memory exhaustion. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Fetch with timeout support.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeout?: number },
): Promise<Response> {
  const timeout = init.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Accept-Language': 'en-US',
        ...init.headers,
      },
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse JSON from a response while enforcing a size limit.
 * Throws if the response body exceeds MAX_RESPONSE_BYTES.
 */
export async function readSafeJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${contentLength} bytes, limit ${MAX_RESPONSE_BYTES}). Use more specific query parameters to reduce results.`,
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${text.length} chars, limit ${MAX_RESPONSE_BYTES}). Use more specific query parameters to reduce results.`,
    );
  }
  return JSON.parse(text);
}

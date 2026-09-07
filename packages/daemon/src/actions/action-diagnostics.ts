import type { Logger } from 'pino';

const messages = {
  destination_blocked: 'HTTP action blocked by destination policy',
  redirect_blocked: 'HTTP action redirect blocked; configure the final destination URL',
  timeout: 'HTTP action deadline exceeded',
  cancelled: 'HTTP action cancelled',
  credentials_unavailable:
    'Action credentials unavailable; check the configured authentication source',
  response_too_large: 'Response too large (limit 2097152 bytes)',
  invalid_response: 'HTTP action returned an invalid response',
  transport_error: 'HTTP action connection failed; check destination and TLS configuration',
  action_failed: 'Action failed; unsafe error details withheld',
} as const;

export class ActionBoundaryError extends Error {
  constructor(readonly category: keyof typeof messages) {
    super(messages[category]);
  }
}

/** Contains only a status and a code-owned operation label, never upstream text. */
export class ActionHttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`${operation} ${status}: upstream response details withheld`);
  }
}

export function safeFailure(error: unknown): {
  category: string;
  message: string;
  status?: number;
} {
  if (error instanceof ActionHttpError) {
    return {
      category: 'upstream_error',
      status: error.status,
      message: `HTTP ${error.status}: upstream response details withheld`,
    };
  }
  if (error instanceof ActionBoundaryError) {
    return { category: error.category, message: messages[error.category] };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { category: 'cancelled', message: messages.cancelled };
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'ENOTFOUND',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ].includes(error.code)
  ) {
    return { category: 'transport_error', message: messages.transport_error };
  }
  // Raw messages, stacks, causes and arbitrary SDK error properties can all
  // contain credentials. Unknown exceptions fail closed at every output sink.
  return { category: 'action_failed', message: messages.action_failed };
}

const SENSITIVE = /token|password|secret|pat|key|credential|auth|bearer/i;

function safeText(text: string, secrets: ReadonlySet<string>): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    for (const form of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
    ]) {
      result = result.split(form).join('[redacted]');
    }
  }
  result = result.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      const sensitive = url.username || url.password || url.search || url.hash;
      return sensitive ? `${url.origin}${url.pathname} [URL credentials/query withheld]` : raw;
    } catch {
      return '[invalid URL withheld]';
    }
  });
  return result.length > 500 ? `${result.slice(0, 100)}... [truncated]` : result;
}

/** Bounded recursive redaction for audit parameters and structured logger data. */
export function redactActionValue(
  value: unknown,
  secrets: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > 8) return '[nested content withheld]';
  if (value instanceof Error) return safeFailure(value);
  if (typeof value === 'string') return safeText(value, secrets);
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => redactActionValue(v, secrets, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, v]) => [
          safeText(key, secrets),
          SENSITIVE.test(key) ? '[redacted]' : redactActionValue(v, secrets, depth + 1),
        ]),
    );
  }
  return value;
}

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Redact before calling pino, including nested child loggers used by handlers. */
export function actionLogger(
  logger: Logger,
  secrets: () => ReadonlySet<string> | undefined,
): Logger {
  return new Proxy(logger, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'child') {
        return (...args: unknown[]) =>
          actionLogger(Reflect.apply(value, target, args) as Logger, secrets);
      }
      if (typeof property === 'string' && LOG_METHODS.has(property)) {
        return (...args: unknown[]) =>
          Reflect.apply(
            value,
            target,
            args.map((arg) => redactActionValue(arg, secrets())),
          );
      }
      return value.bind(target);
    },
  });
}

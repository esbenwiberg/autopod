export type IssueProvider = 'ado' | 'github';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface IssueFetchOptions {
  provider: IssueProvider;
  operation: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class IssueProviderHttpError extends Error {
  constructor(
    public readonly provider: IssueProvider,
    public readonly operation: string,
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = 'IssueProviderHttpError';
  }
}

export class IssueProviderRequestError extends Error {
  public readonly retryable = true;
  public readonly cause: unknown;

  constructor(
    public readonly provider: IssueProvider,
    public readonly operation: string,
    message: string,
    cause: unknown,
  ) {
    super(message);
    this.name = 'IssueProviderRequestError';
    this.cause = cause;
  }
}

export async function fetchIssueProvider(
  url: string,
  init: RequestInit,
  options: IssueFetchOptions,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (isRetryableHttpStatus(response.status) && attempt < retries) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(retryDelayMs);
        continue;
      }

      return response;
    } catch (err) {
      if (attempt >= retries) {
        throw new IssueProviderRequestError(
          options.provider,
          options.operation,
          `${providerLabel(options.provider)} ${options.operation} request failed after ${
            retries + 1
          } attempts: ${describeFetchFailure(err, timeoutMs)}`,
          err,
        );
      }
      await sleep(retryDelayMs);
    }
  }

  throw new IssueProviderRequestError(
    options.provider,
    options.operation,
    `${providerLabel(options.provider)} ${options.operation} request failed`,
    undefined,
  );
}

export function isTransientIssueProviderError(err: unknown): boolean {
  if (err instanceof IssueProviderRequestError) return err.retryable;
  if (err instanceof IssueProviderHttpError) return isRetryableHttpStatus(err.status);

  const message = err instanceof Error ? err.message : String(err);
  return /\b(fetch failed|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)\b/i.test(message);
}

export function isIssueProviderAuthError(err: unknown): boolean {
  return err instanceof IssueProviderHttpError && (err.status === 401 || err.status === 403);
}

export function issueProviderHttpError(
  provider: IssueProvider,
  operation: string,
  response: Response,
  message: string,
): IssueProviderHttpError {
  return new IssueProviderHttpError(
    provider,
    operation,
    response.status,
    response.statusText,
    message,
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function providerLabel(provider: IssueProvider): string {
  return provider === 'ado' ? 'ADO' : 'GitHub';
}

function describeFetchFailure(err: unknown, timeoutMs: number): string {
  const base =
    err instanceof Error && err.name === 'TimeoutError'
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);

  const codes = collectErrorCodes(err);
  return codes.length > 0 ? `${base} (${codes.join(', ')})` : base;
}

function collectErrorCodes(err: unknown): string[] {
  const codes = new Set<string>();
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);

    const withCode = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof withCode.code === 'string' && withCode.code.length > 0) {
      codes.add(withCode.code);
    }
    if (withCode.cause) visit(withCode.cause);
    if (Array.isArray(withCode.errors)) {
      for (const nested of withCode.errors) visit(nested);
    }
  }

  visit(err);
  return [...codes];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

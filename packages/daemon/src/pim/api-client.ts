import { AutopodError, type PimAccountIdentity } from '@autopod/shared';
import { withAbort } from '../actions/handlers/handler.js';
import { configurationError } from '../configuration/configuration-store.js';

export type PimAudience = 'graph' | 'arm';
export interface PimApiClient {
  account: PimAccountIdentity;
  get(audience: PimAudience, path: string, signal?: AbortSignal): Promise<unknown>;
  mutate(
    audience: PimAudience,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<unknown>;
}
const origins = { graph: 'https://graph.microsoft.com', arm: 'https://management.azure.com' };

export function createPimApiClient(
  account: PimAccountIdentity,
  credential: (audience: PimAudience) => Promise<PimAccountIdentity & { token: string }>,
  fetcher: typeof fetch = fetch,
): PimApiClient {
  async function request(
    audience: PimAudience,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const url = new URL(path, origins[audience]);
    if (
      url.origin !== origins[audience] ||
      url.username ||
      url.password ||
      url.hash ||
      [...path].some(
        (character) =>
          character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      configurationError('Invalid PIM provider URL', 'PIM_INVALID_URL');
    const auth = await withAbort(credential(audience), deadline);
    deadline.throwIfAborted();
    if (auth.tenantId !== account.tenantId || auth.principalId !== account.principalId)
      configurationError(
        'PIM account changed; restore the configured user account',
        'PIM_ACCOUNT_CHANGED',
        403,
      );
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        redirect: 'error',
        signal: deadline,
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      configurationError(
        'PIM provider response is unavailable',
        method === 'GET' ? 'PIM_READ_UNAVAILABLE' : 'PIM_WRITE_UNCERTAIN',
        503,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('response too large');
          }
          chunks.push(part.value);
        }
      if (!response.ok)
        configurationError(
          'PIM provider rejected the request',
          `PIM_HTTP_${response.status}`,
          response.status === 403 ? 403 : 502,
        );
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return value;
    } catch (error) {
      if (error instanceof AutopodError && /^PIM_HTTP_[0-9]+$/.test(error.code)) throw error;
      configurationError(
        'PIM provider returned an unreadable response',
        method === 'GET' ? 'PIM_READ_UNAVAILABLE' : 'PIM_WRITE_UNCERTAIN',
        503,
      );
    } finally {
      reader?.releaseLock();
    }
  }
  return {
    account,
    get: (audience, path, signal) => request(audience, 'GET', path, undefined, signal),
    mutate: (audience, method, path, body) => request(audience, method, path, body),
  };
}

/** Following a provider pagination link cannot forward the user's bearer token to another host. */
export async function pimPages(
  client: PimApiClient,
  audience: PimAudience,
  path: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<unknown[]> {
  const values: unknown[] = [];
  const visited = new Set<string>();
  let next: string | null = path;
  while (next) {
    signal.throwIfAborted();
    const url = new URL(next, origins[audience]);
    if (
      url.origin !== origins[audience] ||
      url.username ||
      url.password ||
      url.hash ||
      visited.has(url.href) ||
      visited.size >= 100
    )
      configurationError(
        'PIM discovery pagination is incomplete or invalid',
        'PIM_DISCOVERY_INCOMPLETE',
        503,
      );
    visited.add(url.href);
    const raw = await client.get(audience, `${url.pathname}${url.search}`, signal);
    if (!raw || typeof raw !== 'object' || !('value' in raw) || !Array.isArray(raw.value))
      configurationError('PIM discovery returned an invalid page', 'PIM_DISCOVERY_INCOMPLETE', 503);
    values.push(...raw.value);
    if (values.length > 10_000)
      configurationError(
        'PIM discovery exceeded the result limit',
        'PIM_DISCOVERY_INCOMPLETE',
        503,
      );
    const link: unknown =
      '@odata.nextLink' in raw ? raw['@odata.nextLink'] : 'nextLink' in raw ? raw.nextLink : null;
    if (link !== null && link !== undefined && typeof link !== 'string')
      configurationError(
        'PIM discovery returned an invalid continuation',
        'PIM_DISCOVERY_INCOMPLETE',
        503,
      );
    next = typeof link === 'string' && link ? link : null;
  }
  return values;
}

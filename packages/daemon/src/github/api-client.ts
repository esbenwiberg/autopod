import { configurationError } from '../configuration/configuration-store.js';
import type { DaemonGitHubAuth } from './daemon-github-auth.js';
import type { GitHubMutationClient } from './mutation-broker.js';

const origin = 'https://api.github.com';
/** Fixed origin, no redirects, bounded bodies, and no credential material in returned errors. */
export function createGitHubApiClient(
  auth: DaemonGitHubAuth,
  fetcher: typeof fetch = fetch,
): GitHubMutationClient {
  async function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      [...path].some((c) => c === '\\' || c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    )
      configurationError('Invalid GitHub API path');
    const url = new URL(path, origin);
    if (url.origin !== origin) configurationError('GitHub API origin cannot change');
    const { token } = await auth.resolveCredential();
    const response = await fetcher(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            configurationError(
              'GitHub response exceeded the allowed size',
              'GITHUB_RESPONSE_TOO_LARGE',
            );
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const data: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, data };
  }
  return {
    async get(path) {
      try {
        const response = await request('GET', path);
        if (response.status < 200 || response.status >= 300)
          configurationError(
            'GitHub could not read the selected resource',
            'GITHUB_READ_UNAVAILABLE',
            403,
          );
        return response.data;
      } catch {
        configurationError(
          'GitHub could not read the selected resource',
          'GITHUB_READ_UNAVAILABLE',
          503,
        );
      }
    },
    async mutate(method, path, body) {
      // No automatic retry. The caller's durable ledger handles uncertain outcomes.
      return request(method, path, body);
    },
  };
}

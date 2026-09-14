import { configurationError } from '../configuration/configuration-store.js';
import { createGitHubApiClient } from './api-client.js';
import type { DaemonGitHubAuth } from './daemon-github-auth.js';
import type { GitHubDownloadClient } from './read-broker.js';

const apiOrigin = 'https://api.github.com';
export function createGitHubDownloadClient(
  auth: DaemonGitHubAuth,
  fetcher: typeof fetch = fetch,
): GitHubDownloadClient {
  const api = createGitHubApiClient(auth, fetcher);
  return {
    get: api.get,
    async download(path: string) {
      let url = new URL(path, apiOrigin);
      if (
        url.origin !== apiOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        !path.startsWith('/') ||
        path.startsWith('//')
      )
        configurationError('Invalid GitHub download path', 'GITHUB_DOWNLOAD_DENIED', 403);
      const { token } = await auth.resolveCredential();
      const signal = AbortSignal.timeout(20_000);
      try {
        for (let hop = 0; hop < 4; hop++) {
          const response = await fetcher(url, {
            redirect: 'manual',
            signal,
            headers:
              hop === 0
                ? {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                  }
                : {},
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('Missing signed download URL');
            const next = new URL(location, url);
            if (
              next.protocol !== 'https:' ||
              next.port ||
              next.username ||
              next.password ||
              next.hash ||
              !(
                next.hostname.endsWith('.githubusercontent.com') ||
                next.hostname.endsWith('.blob.core.windows.net')
              )
            )
              throw new Error('Untrusted download origin');
            url = next;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Download unavailable');
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error('Missing download');
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 10 * 1024 * 1024) {
                await reader.cancel();
                throw new Error('Download limit exceeded');
              }
              chunks.push(part.value);
            }
          } finally {
            reader.releaseLock();
          }
          // Returned in memory only. No archive extraction or durable signed-URL retention.
          return {
            bytes: Buffer.concat(chunks),
            mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
          };
        }
        throw new Error('Redirect limit exceeded');
      } catch {
        configurationError(
          'GitHub download is unavailable or exceeds the 10 MiB limit',
          'GITHUB_DOWNLOAD_UNAVAILABLE',
          503,
        );
      }
    },
  };
}

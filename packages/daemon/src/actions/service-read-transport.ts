import type { ServiceReadTransport } from './service-read-broker.js';

/** Credentials stay in fixed-origin daemon requests. Never follow provider redirects. */
export function createServiceReadTransport(
  tokens: { ado(): Promise<string>; logs(): Promise<string> },
  fetcher: typeof fetch = fetch,
): ServiceReadTransport {
  return {
    async request(service, url, body, assertAuthorized) {
      const target = new URL(url);
      const hosts =
        service === 'ado' ? ['dev.azure.com', 'almsearch.dev.azure.com'] : ['api.loganalytics.io'];
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.port ||
        !hosts.includes(target.hostname)
      )
        throw new Error('Service endpoint is outside the allowed origin');
      assertAuthorized();
      const token = await (service === 'ado' ? tokens.ado() : tokens.logs());
      assertAuthorized();
      let response: Response;
      try {
        response = await fetcher(target, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new Error('Service read transport failed');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Service read failed (${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Service response is empty');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2_000_000) throw new Error('Service response exceeds the size limit');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      assertAuthorized();
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw new Error('Service response is not valid JSON');
      }
    },
  };
}

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { ActionBoundaryError } from './action-diagnostics.js';

export type PinnedHttpTransport = (
  url: string,
  init: RequestInit,
  addresses: readonly string[],
) => Promise<Response>;

/** Per-request transport; never uses a global agent, DNS override or redirect. */
export function createPinnedHttpTransport(options: { ca?: string } = {}): PinnedHttpTransport {
  return async (rawUrl, init, addresses) => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported HTTP action protocol');
    }
    if (url.username || url.password) throw new Error('HTTP URL credentials are not supported');
    const address = addresses[0];
    if (!address || addresses.some((ip) => isIP(ip) === 0)) {
      throw new Error('Missing validated HTTP destination');
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    if (init.body != null && typeof init.body !== 'string') {
      throw new Error('Unsupported HTTP action body');
    }
    const headers = new Headers(init.headers);
    headers.set('host', url.host);
    headers.set('accept-encoding', 'gzip, deflate, br');
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      // The original hostname stays in the URL (Host, SNI and certificate
      // verification). Only lookup is replaced with the frozen validated set.
      const req = request(
        url,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers),
          agent: false,
          signal: signal ?? undefined,
          ca: options.ca,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) {
              callback(
                null,
                addresses.map((ip) => ({ address: ip, family: isIP(ip) })),
              );
            } else {
              callback(null, address, isIP(address));
            }
          },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(new ActionBoundaryError('redirect_blocked'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) responseHeaders.append(key, entry);
            } else if (value !== undefined) responseHeaders.set(key, value);
          }
          const encoding = incoming.headers['content-encoding']?.toLowerCase();
          const decoder =
            encoding === 'gzip'
              ? createGunzip()
              : encoding === 'deflate'
                ? createInflate()
                : encoding === 'br'
                  ? createBrotliDecompress()
                  : undefined;
          if (encoding && encoding !== 'identity' && !decoder) {
            incoming.destroy();
            reject(new Error('Unsupported HTTP response encoding'));
            return;
          }
          const decoded = decoder ?? incoming;
          if (decoder) {
            pipeline(incoming, decoder, () => {});
            responseHeaders.delete('content-encoding');
            responseHeaders.delete('content-length');
          }
          // Cancellation of the web body destroys the source and its socket.
          const abort = () => decoded.destroy(new Error('HTTP action aborted'));
          signal?.addEventListener('abort', abort, { once: true });
          decoded.once('close', () => signal?.removeEventListener('abort', abort));
          if (signal?.aborted) abort();
          const noBody =
            init.method === 'HEAD' || status === 204 || status === 205 || status === 304;
          if (noBody) incoming.resume();
          try {
            const response = new Response(
              noBody ? null : (Readable.toWeb(decoded) as ReadableStream<Uint8Array>),
              {
                status,
                headers: responseHeaders,
              },
            );
            Object.defineProperty(response, 'url', { value: url.href });
            resolve(response);
          } catch (error) {
            decoded.destroy();
            reject(error);
          }
        },
      );
      req.once('error', reject);
      req.end(init.body);
    });
  };
}

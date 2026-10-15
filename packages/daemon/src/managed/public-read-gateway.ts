import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ManagedPodRequest } from '@autopod/shared';
import { z } from 'zod';
import { digest } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return (
      a !== undefined &&
      b !== undefined &&
      c !== undefined &&
      a > 0 &&
      a < 224 &&
      ![10, 127].includes(a) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113) &&
      address !== '168.63.129.16'
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^2001:(?:db8|0):/i.test(address) &&
    !/^2002:/i.test(address)
  );
}

export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) ||
    [...url.searchParams.keys()].some((key) => /^(?:sig|token|access_token|api_key)$/i.test(key))
  )
    throw new Error('managed-public-url-refused');
  return url;
}

/** Credential-free GET with public DNS validation and a pinned connection address. */
export async function publicGet(raw: string, redirects = 0): Promise<string> {
  const url = publicUrl(raw);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new Error('managed-public-address-refused');
  const selected = addresses[0]!;
  const family = isIP(selected.address) as 4 | 6;
  const response = await new Promise<{ status: number; location?: string; body: string }>(
    (resolve, reject) => {
      const call = httpsRequest(
        url,
        {
          method: 'GET',
          family,
          lookup: (_hostname, options, callback) =>
            options.all
              ? callback(null, [{ address: selected.address, family }])
              : callback(null, selected.address, family),
          headers: {
            Accept: 'application/json,text/html,text/plain',
            'Accept-Encoding': 'identity',
            'User-Agent': 'AutoPod-managed-public-read/1',
          },
          signal: AbortSignal.timeout(15_000),
        },
        (message) => {
          const chunks: Buffer[] = [];
          let size = 0;
          if (
            message.headers['content-encoding'] &&
            message.headers['content-encoding'] !== 'identity'
          ) {
            message.destroy();
            reject(new Error('managed-public-encoding-refused'));
            return;
          }
          message.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_000_000) {
              message.destroy();
              reject(new Error('managed-public-response-too-large'));
            } else chunks.push(chunk);
          });
          message.on('error', reject);
          message.on('end', () =>
            resolve({
              status: message.statusCode ?? 0,
              location: message.headers.location,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      call.on('error', reject);
      call.end();
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (!response.location || redirects >= 3) throw new Error('managed-public-redirect-refused');
    return publicGet(new URL(response.location, url).href, redirects + 1);
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error('managed-public-http-failure');
  return JSON.stringify({ url: url.href, status: response.status, body: response.body });
}

export class ManagedPublicReadGateway {
  constructor(
    private readonly service: ManagedPodService,
    private readonly transport: (url: string) => Promise<string> = publicGet,
  ) {}
  preflight(request: ManagedPodRequest) {
    if (!request.effectiveGrant.scope.allowedEffects.includes('web.public-read'))
      throw new Error('managed-public-read-not-granted');
  }
  async invoke(installation: string, podId: string, revision: number, key: string, raw: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key) || Buffer.byteLength(raw) > 4096)
      throw new Error('managed-public-request-invalid');
    const value = z
      .object({ url: z.string().min(1).max(4000) })
      .strict()
      .parse(JSON.parse(raw));
    publicUrl(value.url);
    const active = () => {
      const row = this.service.row(installation, podId);
      this.service.requireActive(row);
      if (row.grant_revision !== revision) throw new Error('managed-public-stale-revision');
      this.preflight(JSON.parse(row.request_json) as ManagedPodRequest);
    };
    active();
    const requestDigest = digest(value);
    const previous = this.service.db
      .prepare(
        'SELECT request_digest,grant_revision,response_json FROM managed_public_reads WHERE pod_id=? AND operation_key=?',
      )
      .get(podId, key) as
      | { request_digest: string; grant_revision: number; response_json: string | null }
      | undefined;
    if (
      previous &&
      (previous.request_digest !== requestDigest || previous.grant_revision !== revision)
    )
      throw new Error('managed-public-replay-conflict');
    if (previous?.response_json) return previous.response_json;
    if (!previous) {
      const count = this.service.db
        .prepare('SELECT count(*) AS n FROM managed_public_reads WHERE pod_id=?')
        .get(podId) as { n: number };
      if (count.n >= 64) throw new Error('managed-public-read-limit');
      this.service.db
        .prepare('INSERT INTO managed_public_reads VALUES (?,?,?,?,NULL)')
        .run(podId, key, requestDigest, revision);
    }
    const response = await this.transport(value.url);
    active();
    if (Buffer.byteLength(response) > 1_100_000)
      throw new Error('managed-public-response-too-large');
    this.service.db
      .prepare('UPDATE managed_public_reads SET response_json=? WHERE pod_id=? AND operation_key=?')
      .run(response, podId, key);
    return response;
  }
}

import { createPrivateKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import type { Role } from './combined-attestation.js';
import {
  type ParentEvaluatorEndpoints,
  parentEvaluatorEndpointsSchema,
} from './parent-evaluator-client.js';
import { brokeredReviewDeadlineMs } from './parent-review-broker.js';

const roles = ['checks', 'independentReview'] as const;
const names = { checks: 'checks', independentReview: 'review' } as const;
const maxReply = 2048;
const maxBody = Math.ceil((2 * MAX_PRIVATE_HEAD_BYTES) / 3) * 4 + 8704;
const credentialError = 'parent-evaluator-tls-credentials-required';

type Material = { ca: Buffer; cert: Buffer; key: Buffer };

function certificate(pem: Buffer) {
  if (
    !/^\s*-----BEGIN CERTIFICATE-----[\r\nA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/.test(
      pem.toString('ascii'),
    )
  )
    throw new Error(credentialError);
  const parsed = new X509Certificate(pem);
  if (parsed.validFromDate.getTime() > Date.now() || parsed.validToDate.getTime() <= Date.now())
    throw new Error(credentialError);
  return parsed;
}

/** No system trust, global TLS settings, proxies, redirects, retries or fallback. */
export function createParentEvaluatorTlsFetch(
  endpoints: ParentEvaluatorEndpoints,
  materials: Readonly<Record<Role, Material>>,
  dial = httpsRequest,
  nativeReview = false,
): typeof fetch {
  const bound = parentEvaluatorEndpointsSchema.parse(endpoints);
  const contexts = new Map<string, SecureContext>();
  const roots: Buffer[] = [];
  const identities: Buffer[] = [];
  for (const role of roles) {
    const { ca, cert, key } = materials[role];
    const root = certificate(ca);
    const identity = certificate(cert);
    if (!root.ca || identity.ca || !identity.checkPrivateKey(createPrivateKey(key)))
      throw new Error(credentialError);
    roots.push(root.publicKey.export({ type: 'spki', format: 'der' }));
    identities.push(identity.publicKey.export({ type: 'spki', format: 'der' }));
    contexts.set(bound[role], createSecureContext({ ca, cert, key, minVersion: 'TLSv1.3' }));
  }
  if (roots[0]?.equals(roots[1]!) || identities[0]?.equals(identities[1]!))
    throw new Error('parent-evaluator-tls-credentials-must-be-separate');

  return async (input, init) => {
    const context = typeof input === 'string' ? contexts.get(input) : undefined;
    if (
      !context ||
      typeof input !== 'string' ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string' ||
      Buffer.byteLength(init.body) > maxBody
    )
      throw new Error('parent-evaluator-tls-request-refused');

    const url = new URL(input);
    const body = init.body;
    const timeout = AbortSignal.timeout(
      nativeReview && input === bound.independentReview ? brokeredReviewDeadlineMs : 30_000,
    );
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    return new Promise<Response>((resolve, reject) => {
      const unavailable = () => reject(new Error('parent-evaluator-tls-response-unavailable'));
      const request = dial(
        url,
        {
          method: 'POST',
          secureContext: context,
          servername: url.hostname,
          rejectUnauthorized: true,
          agent: false,
          signal,
          maxHeaderSize: 4096,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          response.once('error', unavailable);
          response.once('aborted', unavailable);
          const type = response.headers['content-type'];
          if (
            response.statusCode !== 200 ||
            response.headers['content-encoding'] ||
            !/^application\/json(?:\s*;.*)?$/i.test(type ?? '')
          ) {
            response.destroy();
            unavailable();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxReply) {
              reject(new Error('parent-evaluator-response-bound'));
              response.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          response.once('end', () => {
            if (!response.complete || size > maxReply) unavailable();
            else
              resolve(
                new Response(Uint8Array.from(Buffer.concat(chunks, size)), {
                  headers: { 'content-type': 'application/json' },
                }),
              );
          });
        },
      );
      request.once('error', unavailable);
      request.end(body);
    });
  };
}

function trustedOwner(uid: number) {
  return uid === 0 || uid === process.getuid?.();
}

async function readCredential(directory: string, name: string, secret: boolean) {
  const f = await open(
    path.join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await f.stat();
    if (
      !info.isFile() ||
      !trustedOwner(info.uid) ||
      info.size < 1 ||
      info.size > 8192 ||
      info.mode & (secret ? 0o077 : 0o022)
    )
      throw new Error(credentialError);
    const buffer = Buffer.alloc(info.size + 1);
    let usable = false;
    try {
      let pos = 0;
      while (pos < buffer.length) {
        const { bytesRead } = await f.read(buffer, pos, buffer.length - pos, pos);
        if (!bytesRead) break;
        pos += bytesRead;
      }
      if (pos !== info.size) throw new Error(credentialError);
      usable = true;
      return buffer.subarray(0, pos);
    } finally {
      if (!usable && secret) buffer.fill(0);
    }
  } finally {
    await f.close();
  }
}

export async function loadParentEvaluatorTlsFetch(
  endpoints: ParentEvaluatorEndpoints,
  directory: string | undefined,
  nativeReview = false,
) {
  const secrets: Buffer[] = [];
  try {
    if (!directory || !path.isAbsolute(directory)) throw new Error(credentialError);
    const dir = await lstat(directory);
    if (
      !dir.isDirectory() ||
      !trustedOwner(dir.uid) ||
      dir.mode & 0o022 ||
      (await realpath(directory)) !== directory
    )
      throw new Error(credentialError);
    const load = async (role: Role) => {
      const stem = 'autopod-parent-evaluator-' + names[role] + '-tls-';
      const ca = await readCredential(directory, stem + 'ca', false);
      const cert = await readCredential(directory, stem + 'cert', false);
      const key = await readCredential(directory, stem + 'key', true);
      secrets.push(key);
      return { ca, cert, key };
    };
    return createParentEvaluatorTlsFetch(
      endpoints,
      {
        checks: await load('checks'),
        independentReview: await load('independentReview'),
      },
      undefined,
      nativeReview,
    );
  } catch {
    throw new Error(credentialError);
  } finally {
    for (const secret of secrets) secret.fill(0);
  }
}

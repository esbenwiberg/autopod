import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonical } from '../managed/canonical.js';
import type { CombinedPolicy, Role } from './combined-attestation.js';

const maxLifetimeSeconds = 60;
const keyError = 'parent-evaluator-dispatch-key-required';

function canonicalBase64(bytes: number) {
  return z.string().refine((value) => {
    if (value.length !== Math.ceil((bytes * 4) / 3)) return false;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value;
  });
}

export const evaluatorDispatchSchema = z
  .object({
    expiresAt: z.number().int().positive(),
    signature: canonicalBase64(64),
  })
  .strict();

type Authorization = z.infer<typeof evaluatorDispatchSchema>;
export type EvaluatorDispatchSigner = (role: Role, inputDigest: string) => Authorization;

function statement(role: Role, digest: string, expiresAt: number) {
  return Buffer.from(canonical(['autopod.parent-evaluator-dispatch/v1', role, digest, expiresAt]));
}

function distinct(publicKey: string, policy: CombinedPolicy) {
  if (publicKey === policy.checks.publicKey || publicKey === policy.independentReview.publicKey)
    throw new Error('parent-evaluator-dispatch-key-must-be-separate');
}

export function createEvaluatorDispatchSigner(
  keys: Readonly<Record<Role, KeyObject>>,
  policy: CombinedPolicy,
): EvaluatorDispatchSigner {
  const pinned = { ...keys };
  const pins = [pinned.checks, pinned.independentReview].map((key) => {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error(keyError);
    const pin = createPublicKey(key).export({ format: 'jwk' }).x;
    if (!pin) throw new Error(keyError);
    distinct(pin, policy);
    return pin;
  });
  if (pins[0] === pins[1]) throw new Error('parent-evaluator-dispatch-key-must-be-separate');
  return (role, inputDigest) => {
    const expiresAt = Math.floor(Date.now() / 1000) + maxLifetimeSeconds;
    const signature = sign(null, statement(role, inputDigest, expiresAt), pinned[role]).toString(
      'base64url',
    );
    return { expiresAt, signature };
  };
}

export function createEvaluatorDispatchVerifier(pin: string, role: Role, policy: CombinedPolicy) {
  if (!canonicalBase64(32).safeParse(pin).success)
    throw new Error('parent-evaluator-dispatch-pin-invalid');
  distinct(pin, policy);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: pin } });
  return (inputDigest: string, authorization: Authorization | undefined) => {
    if (!authorization) return false;
    const { expiresAt, signature } = authorization;
    const now = Math.floor(Date.now() / 1000);
    return (
      expiresAt > now &&
      expiresAt <= now + maxLifetimeSeconds &&
      verify(
        null,
        statement(role, inputDigest, expiresAt),
        key,
        Buffer.from(signature, 'base64url'),
      )
    );
  };
}

/** Host service credential. It is never admitted to a worker or passed to a subprocess. */
async function readKey(credentialsDir: string | undefined, name: string) {
  try {
    if (!credentialsDir || !path.isAbsolute(credentialsDir)) throw new Error();
    const fd = await open(
      path.join(credentialsDir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || stat.mode & 0o077)
        throw new Error();
      const buffer = Buffer.alloc(stat.size + 1);
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== stat.size) throw new Error();
        const key = createPrivateKey(buffer.subarray(0, offset));
        if (key.asymmetricKeyType !== 'ed25519') throw new Error();
        return key;
      } finally {
        buffer.fill(0);
      }
    } finally {
      await fd.close();
    }
  } catch {
    throw new Error(keyError);
  }
}

export async function readEvaluatorDispatchKeys(credentialsDir: string | undefined) {
  const checks = await readKey(credentialsDir, 'autopod-parent-evaluator-checks-dispatch');
  const independentReview = await readKey(
    credentialsDir,
    'autopod-parent-evaluator-review-dispatch',
  );
  return { checks, independentReview };
}

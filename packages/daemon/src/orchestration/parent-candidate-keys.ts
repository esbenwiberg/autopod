import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonical } from '../managed/canonical.js';
import {
  type CombinedPolicy,
  gatePinsSchema,
  gateStatementBytes,
  type Role,
} from './combined-attestation.js';
import type { ParentEvaluatorPorts } from './parent-exact-tree-evaluator.js';

const filename = 'parent-candidate-receipts.json';
const roles = ['checks', 'independentReview'] as const;
const rawKey = z.string().regex(/^[A-Za-z0-9_-]{64}$/);
const fileSchema = z.object({ checks: rawKey, independentReview: rawKey }).strict();
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

async function keyPath(root: string) {
  const uid = process.getuid?.();
  const stat = await lstat(root);
  if (
    !uid ||
    !path.isAbsolute(root) ||
    root !== (await realpath(root)) ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('parent-candidate-key-custody-refused');
  return path.join(root, filename);
}

/** Explicit offline setup. Boot does not generate or rotate keys. */
export async function initializeParentCandidateKeys(root: string) {
  const dest = await keyPath(root);
  const file = await open(dest, 'wx', 0o600);
  try {
    const keys = Object.fromEntries(
      roles.map((role) => {
        const der = generateKeyPairSync('ed25519').privateKey.export({
          format: 'der',
          type: 'pkcs8',
        });
        try {
          return [role, der.toString('base64url')];
        } finally {
          der.fill(0);
        }
      }),
    );
    await file.writeFile(canonical(fileSchema.parse(keys)));
    await file.sync();
  } finally {
    await file.close();
  }
  // A crash must not silently replace the role pair. Leave a partial file
  // closed to reuse; the isolated trial is then stopped, not auto-repaired.
  const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function openParentCandidateKeys(
  root: string,
  checksDigest: string,
  reviewDigest: string,
) {
  const fd = await open(
    await keyPath(root),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const buffer = Buffer.alloc(512);
  const keys = await (async () => {
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size < 1 ||
        stat.size >= buffer.length
      )
        throw new Error('parent-candidate-key-custody-refused');
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== stat.size) throw new Error('parent-candidate-key-custody-refused');
      const raw = fileSchema.parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
      const decode = (role: Role) => {
        const bytes = Buffer.from(raw[role], 'base64url');
        try {
          const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
          if (key.asymmetricKeyType !== 'ed25519')
            throw new Error('parent-candidate-key-type-refused');
          return key;
        } finally {
          bytes.fill(0);
        }
      };
      return { checks: decode('checks'), independentReview: decode('independentReview') };
    } catch {
      throw new Error('parent-candidate-key-custody-refused');
    } finally {
      buffer.fill(0);
      await fd.close();
    }
  })();
  const pins = gatePinsSchema.parse(
    Object.fromEntries(
      roles.map((role) => [
        role,
        {
          identity: role === 'checks' ? 'single-owner-checks' : 'single-owner-review',
          configurationDigest: hash.parse(role === 'checks' ? checksDigest : reviewDigest),
          publicKey: createPublicKey(keys[role]).export({ format: 'jwk' }).x,
        },
      ]),
    ),
  );
  if (pins.checks.publicKey === pins.independentReview.publicKey)
    throw new Error('parent-candidate-role-key-reuse');
  return {
    pins,
    bind(policy: CombinedPolicy, role: Role): ParentEvaluatorPorts['sign'] {
      const authority = pins[role];
      if (canonical(policy[role]) !== canonical(authority))
        throw new Error('parent-candidate-key-pin-mismatch');
      let used = false;
      return async (statement) => {
        if (
          used ||
          statement.role !== role ||
          statement.identity !== authority.identity ||
          statement.configurationDigest !== authority.configurationDigest ||
          statement.status !== 'passed'
        )
          throw new Error('parent-candidate-receipt-refused');
        used = true;
        return {
          statement,
          signature: sign(null, gateStatementBytes(statement), keys[role]).toString('base64url'),
        };
      };
    },
  };
}

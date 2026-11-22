import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { sha256 } from '../managed/canonical.js';
import { gatePolicySchema, gateStatementBytes } from './combined-attestation.js';
import {
  parentEvaluatorLeaseSchema,
  registerParentEvaluatorEndpoint,
} from './parent-evaluator-endpoint.js';
import type { ParentEvaluatorPorts } from './parent-exact-tree-evaluator.js';

const absolute = z.string().min(1).max(2048).refine(path.isAbsolute);
const serviceSchema = z
  .object({
    role: z.enum(['checks', 'independentReview']),
    policy: gatePolicySchema,
    lease: parentEvaluatorLeaseSchema,
    stateDir: absolute,
    scratch: absolute,
    socket: absolute,
    recipe: absolute,
  })
  .strict();

async function readProtected(filename: string, cap: number, secret = false) {
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > cap || stat.mode & (secret ? 0o077 : 0o022))
      throw new Error('evaluator-service-file-invalid');
    const bytes = Buffer.alloc(stat.size + 1);
    let pos = 0;
    while (pos < bytes.length) {
      const { bytesRead } = await fd.read(bytes, pos, bytes.length - pos, pos);
      if (!bytesRead) break;
      pos += bytesRead;
    }
    if (pos !== stat.size) {
      bytes.fill(0);
      throw new Error('evaluator-service-file-invalid');
    }
    return bytes.subarray(0, pos);
  } finally {
    await fd.close();
  }
}

async function ownedDirectory(dir: string, privateOnly: boolean) {
  const resolved = await realpath(dir);
  const stat = await lstat(dir);
  if (
    resolved !== dir ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & (privateOnly ? 0o077 : 0o027)
  )
    throw new Error('evaluator-service-directory-invalid');
  return resolved;
}

function overlap(left: string, right: string) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

/** Unix-only. The socket group is the dedicated authenticated TLS proxy identity. */
export async function startParentEvaluatorService(configFile: string, credentialsDir: string) {
  if (!path.isAbsolute(configFile) || !path.isAbsolute(credentialsDir) || process.getuid?.() === 0)
    throw new Error('evaluator-service-boundary-required');
  const cfg = serviceSchema.parse(
    JSON.parse((await readProtected(configFile, 16384)).toString('utf8')),
  );
  if (Date.now() >= cfg.lease.expiresAt * 1000) throw new Error('evaluator-service-lease-expired');
  const state = await ownedDirectory(cfg.stateDir, true);
  const scratch = await ownedDirectory(cfg.scratch, true);
  const socketDir = await ownedDirectory(path.dirname(cfg.socket), false);
  if (overlap(state, scratch) || overlap(state, socketDir) || overlap(scratch, socketDir))
    throw new Error('evaluator-service-directory-overlap');
  if (!/^[A-Za-z0-9_-]{1,48}\.sock$/.test(path.basename(cfg.socket)))
    throw new Error('evaluator-service-socket-invalid');
  const existing = await lstat(cfg.socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) throw new Error('evaluator-service-socket-exists');

  // Only immutable role-owned code is executed. Never import code from a bundle
  // or resolve a module path provided by a caller. The exact module bytes are signed.
  const source = await readProtected(cfg.recipe, 32768);
  const authority = cfg.policy[cfg.role];
  if (sha256(source) !== authority.configurationDigest)
    throw new Error('evaluator-service-recipe-mismatch');
  const rawKey = await readProtected(
    path.join(credentialsDir, 'evaluator-receipt-key'),
    4096,
    true,
  );
  const key = (() => {
    try {
      return createPrivateKey(rawKey);
    } finally {
      rawKey.fill(0);
    }
  })();
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    createPublicKey(key).export({ format: 'jwk' }).x !== authority.publicKey
  )
    throw new Error('evaluator-service-receipt-key-mismatch');

  const { evaluate } = (await import(
    'data:text/javascript;base64,' + source.toString('base64')
  )) as {
    evaluate?: ParentEvaluatorPorts['evaluate'];
  };
  if (typeof evaluate !== 'function') throw new Error('evaluator-service-recipe-invalid');

  const app = Fastify({
    logger: false,
    requestTimeout: 5000,
    connectionTimeout: 10000,
    forceCloseConnections: 'idle',
  });
  let accepting = false;
  try {
    registerParentEvaluatorEndpoint(app, {
      role: cfg.role,
      policy: cfg.policy,
      lease: cfg.lease,
      stateDir: state,
      scratch,
      // No TCP listener and no HTTP header grants authority. The parent
      // directory must stay non-world-accessible; only the proxy group can connect.
      authorize: () => accepting,
      ports: {
        evaluate,
        async sign(statement) {
          return {
            statement,
            signature: sign(null, gateStatementBytes(statement), key).toString('base64url'),
          };
        },
      },
    });
    await app.listen({ path: cfg.socket });
    await chmod(cfg.socket, 0o660);
    accepting = true;
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

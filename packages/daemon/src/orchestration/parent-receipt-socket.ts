import { lstat, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { canonical } from '../managed/canonical.js';
import { type CombinedPolicy, type Role, verifyGateReceipt } from './combined-attestation.js';
import type { ParentEvaluatorPorts } from './parent-exact-tree-evaluator.js';

export interface ReceiptSocket {
  socket: string;
  uid: number;
}

export async function assertReceiptSocket(endpoint: ReceiptSocket, daemonUid: number | undefined) {
  const { socket, uid } = endpoint;
  if (
    !daemonUid ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    uid === daemonUid ||
    !path.isAbsolute(socket) ||
    path.normalize(socket) !== socket ||
    Buffer.byteLength(socket) > 100 ||
    !/^[a-z0-9_-]+\.sock$/.test(path.basename(socket)) ||
    (await realpath(socket)) !== socket
  )
    throw new Error('parent-receipt-socket-refused');
  const stat = await lstat(socket);
  if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o777) !== 0o660)
    throw new Error('parent-receipt-socket-refused');
  // No writable rename ancestor except a root-owned sticky directory such as
  // /tmp. The immediate parent is role-owned and group-traversable, not writable.
  let dir = path.dirname(socket);
  const parent = await lstat(dir);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o750)
    throw new Error('parent-receipt-socket-refused');
  while (dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
    const entry = await lstat(dir);
    if (
      !entry.isDirectory() ||
      (entry.uid !== 0 && entry.uid !== uid) ||
      (entry.mode & 0o022 && (entry.uid !== 0 || !(entry.mode & 0o1000)))
    )
      throw new Error('parent-receipt-socket-refused');
  }
}

/** Single bounded POST on a pinned Unix socket. No key, TCP, redirect or retry. */
export function createParentReceiptSigner(
  policy: CombinedPolicy,
  role: Role,
  endpoint: ReceiptSocket,
  assertEndpoint: (endpoint: ReceiptSocket) => Promise<void>,
): ParentEvaluatorPorts['sign'] {
  const target = { ...endpoint };
  const pinned = structuredClone(policy);
  let sent = false;
  return async (statement) => {
    const authority = pinned[role];
    if (
      sent ||
      statement.role !== role ||
      statement.identity !== authority.identity ||
      statement.configurationDigest !== authority.configurationDigest ||
      statement.status !== 'passed'
    )
      throw new Error('parent-receipt-request-refused');
    const bytes = Buffer.from(canonical(statement));
    if (bytes.byteLength > 4096) throw new Error('parent-receipt-request-refused');
    sent = true;
    await assertEndpoint(target);
    const raw = await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error('parent-receipt-unavailable'));
      const req = request(
        {
          socketPath: target.socket,
          path: '/v1/parent-receipt',
          method: 'POST',
          agent: false,
          signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', 'content-length': bytes.length },
        },
        (response) => {
          response.on('error', fail);
          if (
            response.statusCode !== 200 ||
            response.headers['content-type'] !== 'application/json'
          ) {
            response.destroy();
            fail();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4096) {
              response.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.once('end', () => {
            if (response.complete) resolve(Buffer.concat(chunks).toString('utf8'));
            else fail();
          });
          response.once('close', () => {
            if (!response.complete) fail();
          });
        },
      );
      req.on('error', fail);
      req.end(bytes);
    });
    // The role owner may replace its socket: filesystem metadata is not
    // peer authentication. Trust the exact Ed25519 receipt, not the listener.
    // Only digests and authority identifiers are sent, not source or keys.
    const receipt = verifyGateReceipt(pinned, role, statement.inputDigest, JSON.parse(raw)).receipt;
    if (canonical(receipt.statement) !== canonical(statement))
      throw new Error('parent-evaluator-receipt-binding');
    return receipt;
  };
}

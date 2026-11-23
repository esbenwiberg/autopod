import { chmod, lstat, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { digest } from '../managed/canonical.js';
import type { ParentEvaluatorPorts } from './parent-exact-tree-evaluator.js';

export const nativeReviewMode = 'native-broker/v1' as const;
export const brokeredReviewDeadlineMs = 120_000;
const maxEvidenceBytes = 16 * 1024;
const maxReplyBytes = 24 * 1024;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const selectorSchema = z
  .object({
    run: z.string().regex(/^[a-f0-9]{64}$/),
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    commit: oid,
    tree: oid,
  })
  .strict();
type Selector = z.infer<typeof selectorSchema>;
type Evidence = Awaited<ReturnType<ParentEvaluatorPorts['evaluate']>>;
const responseSchema = selectorSchema
  .extend({
    status: z.enum(['passed', 'failed']),
    evidence: z
      .string()
      .min(4)
      .max(Math.ceil(maxEvidenceBytes / 3) * 4),
  })
  .strict();
export const reviewBrokerSocketPath = z
  .string()
  .max(100)
  .refine(
    (socket) =>
      Buffer.byteLength(socket) <= 100 &&
      !socket.includes('\0') &&
      path.isAbsolute(socket) &&
      path.normalize(socket) === socket &&
      /^[A-Za-z0-9_-]{1,48}\.sock$/.test(path.basename(socket)),
  );
export const parentReviewBrokerConfigSchema = z
  .object({
    socket: reviewBrokerSocketPath,
    groupId: z.number().int().positive(),
  })
  .strict();

export function nativeReviewConfigurationDigest(socket: string) {
  return digest([
    'autopod.parent-review-recipe/v1',
    nativeReviewMode,
    reviewBrokerSocketPath.parse(socket),
  ]);
}

/** This server is never mounted on the public daemon. Only the explicitly
 * enrolled OS group can connect, and possession of the socket is insufficient
 * without the daemon's currently dispatched exact-tree selector. */
export function createParentReviewBroker(input: z.input<typeof parentReviewBrokerConfigSchema>) {
  const { socket, groupId } = parentReviewBrokerConfigSchema.parse(input);
  type Pending = { selector: Selector; evaluate: () => Promise<Evidence>; claimed: boolean };
  const pending = new Map<string, Pending>();
  const active = new Set<Promise<Evidence>>();
  const app = Fastify({
    logger: false,
    requestTimeout: 5000,
    connectionTimeout: brokeredReviewDeadlineMs,
    forceCloseConnections: 'idle',
  });
  let listening = false;
  let closing: Promise<void> | undefined;
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/ready', async (_req, reply) => {
    if (!listening) return reply.code(503).send({ code: 'review-broker-unavailable' });
    return { ready: true };
  });
  app.post('/review', { bodyLimit: 1024 }, async (req, reply) => {
    const parsed = selectorSchema.safeParse(req.body);
    if (!listening || !parsed.success)
      return reply.code(404).send({ code: 'review-broker-not-enrolled' });
    const selector = parsed.data;
    const work = pending.get(selector.run);
    if (!work || digest(selector) !== digest(work.selector))
      return reply.code(404).send({ code: 'review-broker-not-enrolled' });
    if (work.claimed) return reply.code(409).send({ code: 'review-broker-claimed' });
    // Do not reopen the claim on errors, disconnects, or timeouts.
    work.claimed = true;
    const running = Promise.resolve().then(work.evaluate);
    active.add(running);
    try {
      const result = await running;
      if (
        !Buffer.isBuffer(result.evidence) ||
        !result.evidence.length ||
        result.evidence.length > maxEvidenceBytes
      )
        throw new Error('review-broker-evidence-bound');
      return responseSchema.parse({
        ...work.selector,
        status: result.status,
        evidence: result.evidence.toString('base64'),
      });
    } catch {
      return reply.code(503).send({ code: 'review-broker-outcome-unavailable' });
    } finally {
      active.delete(running);
    }
  });
  return {
    async open() {
      const dir = path.dirname(socket);
      const stat = await lstat(dir);
      if (
        process.getuid?.() === 0 ||
        !stat.isDirectory() ||
        (await realpath(dir)) !== dir ||
        stat.uid !== process.getuid?.() ||
        stat.gid !== groupId ||
        (stat.mode & 0o777) !== 0o750
      )
        throw new Error('review-broker-directory-refused');
      const existing = await lstat(socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existing) throw new Error('review-broker-socket-exists');
      try {
        await app.listen({ path: socket });
        const file = await lstat(socket);
        if (!file.isSocket() || file.uid !== stat.uid || file.gid !== groupId)
          throw new Error('review-broker-socket-ownership-refused');
        await chmod(socket, 0o660);
        listening = true;
      } catch (error) {
        await app.close();
        throw error;
      }
    },
    async withDispatch<T>(
      raw: Selector,
      evaluate: () => Promise<Evidence>,
      send: () => Promise<T>,
    ): Promise<T> {
      const selector = selectorSchema.parse(raw);
      if (!listening || pending.size >= 32 || pending.has(selector.run))
        throw new Error('review-broker-dispatch-refused');
      pending.set(selector.run, { selector, evaluate, claimed: false });
      try {
        return await send();
      } finally {
        pending.delete(selector.run);
      }
    },
    close() {
      listening = false;
      pending.clear();
      closing ??= Promise.allSettled([...active]).then(() => app.close());
      return closing;
    },
  };
}

function brokerCall(socket: string, route: '/ready' | '/review', body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const unavailable = () => reject(new Error('review-broker-unavailable'));
    const req = request(
      {
        socketPath: socket,
        path: route,
        method: body === undefined ? 'GET' : 'POST',
        agent: false,
        signal: AbortSignal.timeout(body === undefined ? 1000 : brokeredReviewDeadlineMs - 2000),
        ...(body === undefined
          ? {}
          : {
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              },
            }),
      },
      (response) => {
        response.on('error', unavailable);
        response.on('aborted', unavailable);
        if (
          response.statusCode !== 200 ||
          !/^application\/json(?:\s*;.*)?$/i.test(String(response.headers['content-type'] ?? ''))
        ) {
          response.destroy();
          unavailable();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxReplyBytes) {
            response.destroy();
            unavailable();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            unavailable();
          }
        });
      },
    );
    req.on('error', unavailable);
    req.end(body);
  });
}

export function nativeBrokerReviewer(raw: string) {
  const socket = reviewBrokerSocketPath.parse(raw);
  return {
    async ready() {
      z.object({ ready: z.literal(true) })
        .strict()
        .parse(await brokerCall(socket, '/ready'));
    },
    async evaluate({
      run,
      inputDigest,
      commit,
      tree,
    }: Parameters<ParentEvaluatorPorts['evaluate']>[0]): Promise<Evidence> {
      const selector = selectorSchema.parse({ run, inputDigest, commit, tree });
      const result = responseSchema.parse(
        await brokerCall(socket, '/review', JSON.stringify(selector)),
      );
      const { status, evidence, ...binding } = result;
      const decoded = Buffer.from(evidence, 'base64');
      if (
        digest(binding) !== digest(selector) ||
        decoded.toString('base64') !== evidence ||
        !decoded.length ||
        decoded.length > maxEvidenceBytes
      )
        throw new Error('review-broker-binding-mismatch');
      return { status, evidence: decoded };
    },
  };
}

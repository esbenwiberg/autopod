import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canonical, sha256 } from '../managed/canonical.js';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import { managedGitBytes } from '../managed/source-git.js';
import type { ParentDeltaSource } from './anchored-delegation-source.js';
import { assertPortableCandidateTree } from './candidate-path-scope.js';
import { type CombinedPolicy, combinedPolicyDigest, type Role } from './combined-attestation.js';
import {
  createEvaluatorDispatchVerifier,
  evaluatorDispatchSchema,
} from './parent-evaluator-dispatch.js';
import {
  createEvaluatorEnrollmentStore,
  type evaluatorEnrollmentConfigSchema,
  evaluatorEnrollmentRequestSchema,
} from './parent-evaluator-enrollment.js';
import { evaluatorReadinessSchema, readinessDigest } from './parent-evaluator-readiness.js';
import {
  type ParentEvaluatorPorts,
  ParentEvaluatorVeto,
  parentExactTreeEvaluator,
} from './parent-exact-tree-evaluator.js';
import {
  parentIntegrationGateDigest,
  parentIntegrationGateRequestSchema,
} from './parent-integration-qualified.js';

const maxBundleBytes = 2 * MAX_PRIVATE_HEAD_BYTES;
const maxEncoded = Math.ceil(maxBundleBytes / 3) * 4;
const maxMetadata = 8192;
const bodySchema = z
  .object({
    request: parentIntegrationGateRequestSchema,
    bundle: z.string().min(4).max(maxEncoded),
    dispatch: evaluatorDispatchSchema.optional(),
  })
  .strict();
export const parentEvaluatorLeaseSchema = z
  .object({
    run: z.string().regex(/^[a-f0-9]{64}$/),
    repository: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    predecessor: z.string().regex(/^[a-f0-9]{40}$/),
    paths: z.array(z.string().min(1).max(160)).min(1).max(32),
    expiresAt: z.number().int().positive(),
    inputDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    dispatchPublicKey: z.string().length(43).optional(),
  })
  .strict()
  .refine((lease) => Boolean(lease.inputDigest) !== Boolean(lease.dispatchPublicKey));
export type ParentEvaluatorLease = z.input<typeof parentEvaluatorLeaseSchema>;

interface EndpointConfig {
  policy: CombinedPolicy;
  role: Role;
  /** Private persistent directory, writable by this role's service identity only. */
  stateDir: string;
  /** Private scratch, no worker checkout or daemon state. */
  scratch: string;
  /** Authenticated ingress identity, not a caller-supplied role/header. No public mode. */
  authorize: (request: FastifyRequest) => boolean;
  ports: ParentEvaluatorPorts;
}
type LeaseMode =
  | { lease: ParentEvaluatorLease; enrollment?: never; resolveBase?: never }
  | {
      enrollment: z.input<typeof evaluatorEnrollmentConfigSchema>;
      lease?: never;
      resolveBase?: (predecessor: string) => Promise<ParentDeltaSource>;
    };

async function claim(stateDir: string, role: Role, run: string, input: string) {
  const file = path.join(stateDir, role + '-' + run + '.claim');
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await fd.writeFile(input + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
  const directory = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Install in a separate, role-owned private evaluator app, never in the daemon HTTP listener. */
export function registerParentEvaluatorEndpoint(
  app: FastifyInstance,
  config: EndpointConfig & LeaseMode,
) {
  const { role, stateDir, scratch, authorize } = config;
  if (role !== 'checks' && role !== 'independentReview')
    throw new Error('parent-evaluator-role-invalid');
  if (!path.isAbsolute(stateDir) || !path.isAbsolute(scratch) || stateDir === scratch)
    throw new Error('parent-evaluator-private-directories-required');
  const fixedLease = config.lease && parentEvaluatorLeaseSchema.parse(config.lease);
  const expired = (lease: ParentEvaluatorLease) => Date.now() >= lease.expiresAt * 1000;
  const store =
    config.enrollment &&
    createEvaluatorEnrollmentStore({
      ...config,
      enrollment: config.enrollment,
      assertBase: config.resolveBase,
    });
  if (Boolean(fixedLease) === Boolean(store)) throw new Error('parent-evaluator-mode-invalid');
  const fixedPolicy = structuredClone(config.policy);
  // Preserve validation at startup for fixed leases, including key separateness.
  if (fixedLease?.dispatchPublicKey)
    createEvaluatorDispatchVerifier(fixedLease.dispatchPublicKey, role, fixedPolicy);
  combinedPolicyDigest(fixedPolicy);
  app.post(
    '/verify',
    {
      bodyLimit: maxEncoded + maxMetadata + 512,
      onRequest: async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (authorize(request) !== true) return reply.code(404).send({ code: 'not-found' });
        if (fixedLease && expired(fixedLease))
          return reply.code(410).send({ code: 'evaluator-lease-expired' });
        if (
          request.headers['content-encoding'] ||
          !/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')
        )
          return reply.code(415).send({ code: 'evaluator-content-type' });
      },
    },
    async (request, reply) => {
      if (store) {
        const registration = evaluatorEnrollmentRequestSchema.safeParse(request.body);
        if (registration.success) {
          try {
            const result = await store.enroll(registration.data);
            if (result.status === 'denied')
              return reply.code(403).send({ code: 'evaluator-enrollment-denied' });
            if (result.status === 'conflict')
              return reply.code(409).send({ code: 'evaluator-enrollment-conflict' });
            if (result.status === 'expired')
              return reply.code(410).send({ code: 'evaluator-lease-expired' });
            return { enrolled: true, enrollmentDigest: result.enrollmentDigest };
          } catch {
            return reply.code(503).send({ code: 'evaluator-enrollment-unavailable' });
          }
        }
      }
      const probe = evaluatorReadinessSchema.safeParse(request.body);
      const parsed = bodySchema.safeParse(request.body);
      const run = probe.success ? probe.data.readiness.run : parsed.data?.request.subject.run;
      if (!run) return reply.code(400).send({ code: 'evaluator-input-invalid' });
      const binding = await (async () => {
        try {
          return fixedLease
            ? { lease: fixedLease, policy: fixedPolicy, resultTransport: undefined }
            : await store?.resolve(run);
        } catch {
          return null;
        }
      })();
      if (binding === null)
        return reply.code(503).send({ code: 'evaluator-enrollment-unavailable' });
      if (!binding) return reply.code(403).send({ code: 'evaluator-input-not-enrolled' });
      const { lease, policy }: { lease: ParentEvaluatorLease; policy: CombinedPolicy } = binding;
      if (expired(lease)) return reply.code(410).send({ code: 'evaluator-lease-expired' });
      const expectedPaths = canonical(lease.paths);
      const policyDigest = combinedPolicyDigest(policy);
      const verifyDispatch = lease.dispatchPublicKey
        ? createEvaluatorDispatchVerifier(lease.dispatchPublicKey, role, policy)
        : undefined;
      if (probe.success) {
        const { readiness, dispatch } = probe.data;
        const bindingDigest = readinessDigest(readiness);
        if (
          !verifyDispatch ||
          !verifyDispatch(bindingDigest, dispatch) ||
          readiness.run !== lease.run ||
          readiness.repository !== lease.repository ||
          readiness.predecessor !== lease.predecessor ||
          readiness.policyDigest !== policyDigest ||
          canonical(readiness.paths) !== expectedPaths ||
          expired(lease)
        ) {
          return reply.code(403).send({ code: 'evaluator-readiness-not-enrolled' });
        }
        try {
          await lstat(path.join(stateDir, role + '-' + lease.run + '.claim'));
          return reply.code(409).send({ code: 'evaluator-attempt-already-claimed' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            return reply.code(503).send({ code: 'evaluator-claim-unavailable' });
        }
        return { ready: true, bindingDigest };
      }
      if (!parsed.success) return reply.code(400).send({ code: 'evaluator-input-invalid' });
      const { request: input, bundle: encoded, dispatch } = parsed.data;
      const inputDigest = parentIntegrationGateDigest(input);
      if (
        input.subject.run !== lease.run ||
        input.subject.repository !== lease.repository ||
        input.subject.predecessor !== lease.predecessor ||
        input.subject.policyDigest !== policyDigest ||
        canonical(input.paths) !== expectedPaths ||
        input.resultTransport !== binding.resultTransport ||
        Buffer.byteLength(canonical(input)) > maxMetadata ||
        (verifyDispatch
          ? !verifyDispatch(inputDigest, dispatch)
          : dispatch !== undefined || inputDigest !== lease.inputDigest)
      )
        return reply.code(403).send({ code: 'evaluator-input-not-enrolled' });
      const bytes = Buffer.from(encoded, 'base64');
      if (
        !bytes.length ||
        bytes.length > maxBundleBytes ||
        bytes.toString('base64') !== encoded ||
        sha256(bytes) !== input.bundleDigest
      )
        return reply.code(400).send({ code: 'evaluator-bundle-invalid' });
      if (expired(lease)) return reply.code(410).send({ code: 'evaluator-lease-expired' });
      try {
        // Even a lost response or veto is not permission to send again.
        await claim(stateDir, role, lease.run, inputDigest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          return reply.code(409).send({ code: 'evaluator-attempt-already-claimed' });
        return reply.code(503).send({ code: 'evaluator-claim-unavailable' });
      }
      try {
        if (expired(lease)) return reply.code(410).send({ code: 'evaluator-lease-expired' });
        const ports = store
          ? {
              ...config.ports,
              async evaluate(selection: Parameters<ParentEvaluatorPorts['evaluate']>[0]) {
                // Trust the enrolled scope, not a signed claim about the bundle contents.
                const diff = await managedGitBytes(
                  selection.mirror,
                  [
                    'diff-tree',
                    '--no-commit-id',
                    '--name-only',
                    '--no-renames',
                    '-r',
                    '-z',
                    selection.predecessor,
                    selection.commit,
                    '--',
                  ],
                  undefined,
                  [],
                  { input: '', timeout: 5000, maxBuffer: maxMetadata },
                );
                const paths = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
                  .decode(diff)
                  .split('\0');
                if (paths.pop() !== '' || canonical(paths.sort()) !== expectedPaths)
                  throw new ParentEvaluatorVeto(role);
                if (config.resolveBase)
                  await assertPortableCandidateTree(
                    selection.mirror,
                    selection.commit,
                    selection.predecessor,
                  );
                return config.ports.evaluate(selection);
              },
            }
          : config.ports;
        const receipt = await parentExactTreeEvaluator(
          scratch,
          policy,
          role,
          ports,
          config.resolveBase,
        )(input, bytes);
        if (expired(lease)) return reply.code(410).send({ code: 'evaluator-lease-expired' });
        return receipt;
      } catch (error) {
        if (error instanceof ParentEvaluatorVeto)
          return reply.code(422).send({ code: 'evaluator-veto' });
        return reply.code(503).send({ code: 'evaluator-outcome-unavailable' });
      }
    },
  );
}

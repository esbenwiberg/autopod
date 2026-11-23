import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonical, digest } from '../managed/canonical.js';
import {
  type CombinedPolicy,
  combinedPolicyDigest,
  gatePolicySchema,
  type Role,
} from './combined-attestation.js';
import {
  type ParentEvaluatorEndpoints,
  parentEvaluatorEndpointsSchema,
} from './parent-evaluator-client.js';
import {
  createEvaluatorDispatchVerifier,
  type EvaluatorDispatchSigner,
  evaluatorDispatchSchema,
} from './parent-evaluator-dispatch.js';
import { evaluatorReadinessSchema } from './parent-evaluator-readiness.js';

const bindingSchema = evaluatorReadinessSchema.shape.readiness;
const orderedPaths = z
  .array(z.string().min(1).max(160))
  .min(1)
  .max(32)
  .refine((paths) =>
    paths.every(
      (name, i) =>
        (!i || paths[i - 1]! < name) &&
        name
          .split('/')
          .every(
            (part) =>
              /^[A-Za-z0-9_.-]+$/.test(part) &&
              part !== '.' &&
              part !== '..' &&
              part.toLowerCase() !== '.git',
          ),
    ),
  );
export const evaluatorEnrollmentConfigSchema = z
  .object({
    repository: bindingSchema.shape.repository,
    paths: orderedPaths,
    dispatchPublicKey: z.string().length(43),
    leaseSeconds: z.number().int().min(60).max(86_400),
  })
  .strict();
const enrollmentSchema = bindingSchema
  .omit({ policyDigest: true })
  .extend({
    paths: orderedPaths,
    basePolicyDigest: gatePolicySchema.shape.basePolicyDigest,
    resultTransport: z.literal('anchored/v1').optional(),
  })
  .strict();
export type EvaluatorEnrollment = z.infer<typeof enrollmentSchema>;
export const evaluatorEnrollmentRequestSchema = z
  .object({
    enrollment: enrollmentSchema,
    dispatch: evaluatorDispatchSchema,
  })
  .strict();
const recordSchema = z
  .object({
    enrollment: enrollmentSchema,
    policyDigest: bindingSchema.shape.policyDigest,
    dispatchPublicKey: evaluatorEnrollmentConfigSchema.shape.dispatchPublicKey,
    expiresAt: z.number().int().positive(),
  })
  .strict();
const enrollmentDigest = (value: EvaluatorEnrollment, policyDigest: string) =>
  digest(['autopod.evaluator-enrollment/v1', value, policyDigest]);

/** Both URLs are the same exact mTLS-pinned POST targets used for evaluation.
 * Registration sends no source or executable settings; each role supplies them. */
export async function enrollParentEvaluators(
  endpoints: ParentEvaluatorEndpoints,
  transport: typeof fetch,
  sign: EvaluatorDispatchSigner,
  selection: EvaluatorEnrollment,
  policy: CombinedPolicy,
) {
  const bound = parentEvaluatorEndpointsSchema.parse(endpoints);
  const enrollment = enrollmentSchema.parse(selection);
  if (enrollment.basePolicyDigest !== policy.basePolicyDigest)
    throw new Error('evaluator-enrollment-policy-mismatch');
  const id = enrollmentDigest(enrollment, combinedPolicyDigest(policy));
  for (const role of ['checks', 'independentReview'] as const) {
    const response = await transport(bound[role], {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ enrollment, dispatch: sign(role, id) }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    try {
      if (response.status !== 200 || response.redirected)
        throw new Error('evaluator-enrollment-unavailable');
      z.object({ enrolled: z.literal(true), enrollmentDigest: z.literal(id) })
        .strict()
        .parse(await response.json());
    } finally {
      if (response.body) void response.body.cancel().catch(() => {});
    }
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}
const recordLimit = 8192;
type EnrollmentRecord = z.infer<typeof recordSchema>;

/** Role-owned write-once leases. A temporary file and exclusive hard link
 * publish the whole record at once, even across independent service processes. */
export function createEvaluatorEnrollmentStore(input: {
  role: Role;
  stateDir: string;
  policy: CombinedPolicy;
  enrollment: z.input<typeof evaluatorEnrollmentConfigSchema>;
  assertBase?: (predecessor: string) => Promise<unknown>;
}) {
  const { role, stateDir } = input;
  const config = evaluatorEnrollmentConfigSchema.parse(input.enrollment);
  const pins = gatePolicySchema.parse(input.policy);
  const policyFor = (basePolicyDigest: string) => ({ ...pins, basePolicyDigest });
  const verifyDispatch = createEvaluatorDispatchVerifier(config.dispatchPublicKey, role, pins);
  const claimFile = (run: string) => path.join(stateDir, `${role}-${run}.claim`);
  const recordFile = (run: string) => path.join(stateDir, `${role}-${run}.enrollment`);
  const expectedPaths = canonical(config.paths);
  const permitted = (e: EvaluatorEnrollment) =>
    e.repository === config.repository && canonical(e.paths) === expectedPaths;

  async function read(run: string) {
    const file = await open(
      recordFile(bindingSchema.shape.run.parse(run)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!file) return;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > recordLimit || stat.mode & 0o077)
        throw new Error('evaluator-enrollment-record-invalid');
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('evaluator-enrollment-record-invalid');
      const record = recordSchema.parse(JSON.parse(bytes.toString('utf8', 0, bytesRead)));
      if (
        record.enrollment.run !== run ||
        record.dispatchPublicKey !== config.dispatchPublicKey ||
        !permitted(record.enrollment) ||
        combinedPolicyDigest(policyFor(record.enrollment.basePolicyDigest)) !== record.policyDigest
      )
        throw new Error('evaluator-enrollment-record-invalid');
      return record;
    } finally {
      await file.close();
    }
  }

  async function create(record: EnrollmentRecord) {
    const temp = path.join(stateDir, `.enrollment-${randomUUID()}`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try {
        await file.writeFile(canonical(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temp, recordFile(record.enrollment.run)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    } finally {
      await unlink(temp);
    }
  }

  return {
    async enroll({ enrollment, dispatch }: z.infer<typeof evaluatorEnrollmentRequestSchema>) {
      const policyDigest = combinedPolicyDigest(policyFor(enrollment.basePolicyDigest));
      const id = enrollmentDigest(enrollment, policyDigest);
      if (
        !permitted(enrollment) ||
        !verifyDispatch(id, dispatch) ||
        Boolean(input.assertBase) !== (enrollment.resultTransport === 'anchored/v1')
      )
        return { status: 'denied' } as const;
      await input.assertBase?.(enrollment.predecessor);
      let current = await read(enrollment.run);
      if (!current) {
        await create({
          enrollment,
          policyDigest,
          dispatchPublicKey: config.dispatchPublicKey,
          expiresAt: now() + config.leaseSeconds,
        });
        current = await read(enrollment.run);
        if (!current) throw new Error('evaluator-enrollment-record-missing');
      }
      if (enrollmentDigest(current.enrollment, current.policyDigest) !== id)
        return { status: 'conflict' } as const;
      if (current.expiresAt <= now()) return { status: 'expired' } as const;
      // A matching replay can race the first writer. Sync before either acknowledges.
      const directory = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const claim = await open(
        claimFile(enrollment.run),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (claim) {
        await claim.close();
        return { status: 'conflict' } as const;
      }
      return { status: 'enrolled', enrollmentDigest: id } as const;
    },
    async resolve(run: string) {
      const record = await read(run);
      if (!record) return;
      const { basePolicyDigest, resultTransport, ...binding } = record.enrollment;
      if (Boolean(input.assertBase) !== (resultTransport === 'anchored/v1'))
        throw new Error('evaluator-enrollment-transport-mismatch');
      return {
        resultTransport,
        lease: {
          ...binding,
          expiresAt: record.expiresAt,
          dispatchPublicKey: config.dispatchPublicKey,
        },
        policy: policyFor(basePolicyDigest),
      };
    },
  };
}

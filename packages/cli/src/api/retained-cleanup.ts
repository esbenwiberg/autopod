import { retainedCleanupRequestIdSchema, retainedCleanupRequestSchema } from '@autopod/shared';
import { z } from 'zod';

const nonempty = z.string().min(1);
const blocker = z.object({ code: nonempty, message: nonempty, resourceId: nonempty.optional() });
const resource = z
  .object({
    kind: z.enum(['docker_container', 'docker_bridge', 'host_worktree', 'host_prepared_root']),
    role: z.enum([
      'guest_execution',
      'owned_bridge',
      'original_checkout',
      'prepared_checkout',
      'private_prepared_source',
    ]),
    id: nonempty,
    namespace: nonempty,
  })
  .refine(
    ({ kind, role }) =>
      (kind === 'docker_container' && role === 'guest_execution') ||
      (kind === 'docker_bridge' && role === 'owned_bridge') ||
      (kind === 'host_worktree' && ['original_checkout', 'prepared_checkout'].includes(role)) ||
      (kind === 'host_prepared_root' && role === 'private_prepared_source'),
  );
const plan = z.object({
  version: z.literal(1),
  generation: retainedCleanupRequestSchema.shape.expectedGeneration,
  binding: retainedCleanupRequestSchema.shape.expectedBinding,
  sessionId: retainedCleanupRequestSchema.shape.expectedSessionId,
  resources: z
    .array(resource)
    .min(1)
    .refine(
      (items) =>
        new Set(items.map(({ kind, id, namespace }) => JSON.stringify([kind, namespace, id])))
          .size === items.length,
    ),
  dataLoss: z.array(nonempty).min(1),
  retained: z.array(nonempty).min(1),
  notReclaimed: z.array(nonempty).min(1),
});
const blocked = z.object({
  state: z.literal('blocked'),
  podId: nonempty,
  blockers: z.array(blocker).min(1),
});
const inspection = z.discriminatedUnion('state', [
  blocked,
  z.object({ state: z.literal('eligible'), podId: nonempty, plan }),
  z.object({
    state: z.literal('requested'),
    podId: nonempty,
    requestId: retainedCleanupRequestIdSchema,
  }),
]);

const progressState = z.enum(['pending', 'removal_unconfirmed', 'confirmed_absent']);
const receipt = z.object({
  state: z.enum(['pending', 'partial', 'deleted']),
  podId: nonempty,
  request: retainedCleanupRequestSchema,
  actor: z.object({
    type: z.literal('human'),
    userId: nonempty.refine((s) => s.trim().length > 0),
  }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  plan,
  blockers: z.array(blocker),
  resources: z.array(z.intersection(resource, z.object({ state: progressState }))),
});

type CleanupRequest = z.infer<typeof retainedCleanupRequestSchema>;

export function cleanupPodPath(podId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(podId)) throw new Error('Supply an exact pod ID.');
  return `/pods/${podId}/retained-cleanup`;
}

export function cleanupInspection(value: unknown, podId: string) {
  const parsed = inspection.parse(value);
  if (parsed.podId !== podId) throw new Error('Cleanup preview belongs to a different pod.');
  return parsed;
}

export function cleanupReceipt(value: unknown, podId: string, expected: string | CleanupRequest) {
  const parsed = receipt.parse(value);
  const { request, plan, resources } = parsed;
  const id = typeof expected === 'string' ? expected : expected.id;
  if (
    parsed.podId !== podId ||
    request.id !== id ||
    (typeof expected !== 'string' &&
      Object.keys(expected).some(
        (key) => expected[key as keyof CleanupRequest] !== request[key as keyof CleanupRequest],
      )) ||
    (value as { request: CleanupRequest }).request.reason !== request.reason ||
    plan.generation !== request.expectedGeneration ||
    plan.binding !== request.expectedBinding ||
    plan.sessionId !== request.expectedSessionId ||
    plan.resources.length !== resources.length ||
    !plan.resources.every((target, i) => {
      const item = resources[i];
      return (
        item &&
        target.id === item.id &&
        target.namespace === item.namespace &&
        target.kind === item.kind &&
        target.role === item.role
      );
    }) ||
    (parsed.state === 'deleted' &&
      (parsed.blockers.length || resources.some((item) => item.state !== 'confirmed_absent'))) ||
    (parsed.state === 'pending' &&
      (parsed.blockers.length || resources.some((item) => item.state !== 'pending')))
  )
    throw new Error('Cleanup receipt does not prove the exact request and resource outcome.');
  return parsed;
}

export function cleanupSubmission(value: unknown, podId: string, expected: CleanupRequest) {
  if ((value as { state?: string } | null)?.state === 'blocked') {
    const parsed = blocked.parse(value);
    if (parsed.podId !== podId) throw new Error('Cleanup rejection belongs to a different pod.');
    return parsed;
  }
  return cleanupReceipt(value, podId, expected);
}

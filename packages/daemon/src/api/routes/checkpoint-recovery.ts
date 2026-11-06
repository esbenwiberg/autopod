import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';
import { observeCheckpointSelection } from '../../pods/retained-checkpoint-recovery.js';

export function checkpointRecoveryRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    | 'getCheckpointRecoveries'
    | 'getCheckpointRecoverySelection'
    | 'recoverCheckpoint'
    | 'reconcileCheckpointOutcome'
    | 'continueRetained'
    | 'previewRetainedExecution'
    | 'checkRetainedCandidate'
    | 'prepareRewriteRepair'
    | 'checkRewriteRepair'
    | 'getApprovalSourceRewrite'
  > &
    Partial<Pick<PodManager, 'inspectRetainedContinuation'>>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  const identity = {
    rewriteId: z.string().min(1).max(128),
    failedDispatchId: z.string().min(1).max(128),
    expectedGeneration: z.number().int().min(1),
    expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(10).max(4000),
  };
  app.get('/pods/:podId/approval-rewrite-repair', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return {
      rewrite: manager.getApprovalSourceRewrite(podId),
      operations: manager.getCheckpointRecoveries(podId),
    };
  });
  app.post('/pods/:podId/approval-rewrite-repair', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        ...identity,
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        checkpointHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      })
      .strict()
      .parse(request.body);
    const operation = await manager.prepareRewriteRepair(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({ operation });
  });
  app.post('/pods/:podId/approval-rewrite-repair/:recoveryId/check', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId, recoveryId } = params
      .extend({ recoveryId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) })
      .parse(request.params);
    const input = z
      .object({ ...identity, candidateHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) })
      .strict()
      .parse(request.body);
    const operation = await manager.checkRewriteRepair(podId, recoveryId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({ operation });
  });

  app.get('/pods/:podId/retained-continuation/execution', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const { profileId } = z
      .object({ profileId: z.string().min(1).max(128) })
      .strict()
      .parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return manager.previewRetainedExecution(podId, profileId);
  });
  app.post('/pods/:podId/retained-continuation', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().min(1),
        expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
        checkpointHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        remoteHead: z
          .string()
          .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
          .optional(),
        prepareOnly: z.boolean().default(false),
        executionProfileId: z.string().min(1).max(128).optional(),
        expectedExecutionDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(request.body);
    const operation = await manager.continueRetained(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({ operation });
  });
  // Separate transport: an old daemon must 404, never ignore a requested allowance.
  for (const budgeted of [false, true]) {
    app.post(
      `/pods/:podId/retained-continuation/:recoveryId/${budgeted ? 'check-budgeted' : 'check'}`,
      async (request, reply) => {
        if (!request.user?.oid)
          throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
        const { podId, recoveryId } = params
          .extend({ recoveryId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) })
          .parse(request.params);
        const input = z
          .object({
            expectedGeneration: z.number().int().min(1),
            expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
            candidateHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
            testBudget: z
              .object({
                seconds: z.number().int().min(1).max(3600),
                reason: z.string().trim().min(10).max(4000),
              })
              .strict()
              .optional(),
            executionProfileId: z.string().trim().min(1).max(128).optional(),
            expectedExecutionDigest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            reason: z.string().trim().min(10).max(4000),
          })
          .strict()
          .refine(
            (value) => (budgeted ? Boolean(value.testBudget) : value.testBudget === undefined),
            'A test allowance is required on check-budgeted and refused on ordinary check',
          )
          .refine(
            (value) => Boolean(value.executionProfileId) === Boolean(value.expectedExecutionDigest),
            'Execution profile and digest must be paired',
          )
          .parse(request.body);
        const operation = await manager.checkRetainedCandidate(podId, recoveryId, input, {
          type: 'human',
          userId: request.user.oid,
        });
        reply.header('Cache-Control', 'no-store');
        return reply.code(202).send({ operation });
      },
    );
  }
  app.get('/pods/:podId/checkpoint-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    const observed = observeCheckpointSelection(() =>
      manager.getCheckpointRecoverySelection(podId),
    );
    return {
      operations: manager.getCheckpointRecoveries(podId),
      selection: observed.selection,
      ...(observed.refusal ? { selectionRefusal: observed.refusal } : {}),
      inspection: manager.inspectRetainedContinuation?.(podId) ?? null,
    };
  });
  app.post('/pods/:podId/checkpoint-recovery/:recoveryId/reconcile', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId, recoveryId } = params
      .extend({
        recoveryId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
      })
      .parse(request.params);
    const input = z
      .object({
        expectedGeneration: z.number().int().min(1),
        expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
        expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(request.body);
    const operation = await manager.reconcileCheckpointOutcome(podId, recoveryId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return { operation };
  });
  app.post('/pods/:podId/checkpoint-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().min(1),
        expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
        checkpointHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(request.body);
    const operation = await manager.recoverCheckpoint(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({ operation });
  });
}

import {
  type EffectiveLaunchConfig,
  type RepositoryConfig,
  deploymentRequestSchema,
} from '@autopod/shared';
import { z } from 'zod';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { configurationError } from '../configuration/configuration-store.js';
import type { DeploymentRun, createDeploymentRunRepository } from './deployment-run-repository.js';
import { prepareDeploymentSource } from './deployment-source.js';
import type { DeploymentRunnerResult, IsolatedDeploymentInput } from './isolated-deploy-runner.js';

/** Operator-owned runner enrollment, outside agent-editable repository/launch configuration. */
export const deploymentTargetSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    repositoryId: z.string().min(1),
    setupId: z.string().min(1),
    image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    allowedScripts: z.array(deploymentRequestSchema.shape.scriptPath).min(1),
    allowedEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    allowedHosts: z
      .array(z.string().regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/))
      .default([]),
    memoryBytes: z
      .number()
      .int()
      .min(64 * 1024 ** 2)
      .max(16 * 1024 ** 3)
      .default(1024 ** 3),
    cpus: z.number().positive().max(16).default(1),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(15 * 60_000)
      .default(5 * 60_000),
  })
  .strict();
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;
export interface DeploymentServiceOptions {
  runs: ReturnType<typeof createDeploymentRunRepository>;
  context(podId: string): { config: EffectiveLaunchConfig; ownerId: string };
  target(config: EffectiveLaunchConfig): DeploymentTarget;
  assertCurrent(config: EffectiveLaunchConfig): void;
  publishedDefault(repository: RepositoryConfig): Promise<{ branch: string; commit: string }>;
  archive(repository: RepositoryConfig, commit: string): Promise<Buffer>;
  credentials(config: EffectiveLaunchConfig): Promise<Record<string, string>>;
  credentialRevisions(config: EffectiveLaunchConfig): Record<string, number>;
  run(target: DeploymentTarget, input: IsolatedDeploymentInput): Promise<DeploymentRunnerResult>;
  stop(run: DeploymentRun): Promise<void>;
  now?(): Date;
}

export function createDeploymentService(options: DeploymentServiceOptions) {
  const { runs } = options;
  const executions = new Map<string, Promise<void>>();
  const now = options.now ?? (() => new Date());
  function selected(podId: string) {
    const { config, ownerId } = options.context(podId);
    options.assertCurrent(config);
    const repository = config.repository;
    const deployment = repository?.setup.integrations.deployment;
    if (!repository || !deployment?.enabled || deployment.source !== 'published-default')
      configurationError('Deployment is not selected for this pod', 'DEPLOYMENT_NOT_SELECTED', 403);
    if (repository.config.provider !== 'github')
      configurationError(
        'Published default deployment currently requires GitHub',
        'DEPLOYMENT_SOURCE_UNAVAILABLE',
        409,
      );
    const target = deploymentTargetSchema.parse(options.target(config));
    if (
      target.id !== deployment.targetId ||
      target.repositoryId !== repository.id ||
      target.setupId !== repository.setup.id
    )
      configurationError(
        'Deployment target does not match the selected repository setup',
        'DEPLOYMENT_TARGET_DENIED',
        403,
      );
    if (Object.keys(deployment.env).some((key) => !target.allowedEnv.includes(key)))
      configurationError(
        'Deployment environment is outside the target allowlist',
        'DEPLOYMENT_ENV_DENIED',
        403,
      );
    return { config, ownerId, repository, deployment, target };
  }
  function bound(run: DeploymentRun) {
    const context = selected(run.plan.podId);
    if (
      context.ownerId !== run.plan.ownerId ||
      context.config.digest !== run.plan.launchDigest ||
      configurationDigest(context.target) !== run.plan.runnerDigest ||
      configurationDigest(options.credentialRevisions(context.config)) !==
        configurationDigest(run.plan.credentialRevisions) ||
      configurationDigest({
        env: context.deployment.env,
        references: context.config.credentialReferences,
      }) !== run.plan.environmentDigest
    )
      configurationError(
        'Deployment authority changed after preparation',
        'DEPLOYMENT_PLAN_CHANGED',
        409,
      );
    return context;
  }
  function owner(run: DeploymentRun, actorId: string) {
    if (run.plan.ownerId !== actorId)
      configurationError('Deployment belongs to another operator', 'DEPLOYMENT_ACCESS_DENIED', 403);
  }
  async function source(run: DeploymentRun) {
    const context = bound(run);
    const bundle = await prepareDeploymentSource(
      await options.archive(context.repository.config, run.plan.sourceCommit),
      run.plan.scriptPath,
    );
    bound(run);
    if (
      bundle.sourceDigest !== run.plan.sourceDigest ||
      bundle.scriptDigest !== run.plan.scriptDigest
    )
      configurationError('Pinned deployment source changed', 'DEPLOYMENT_SOURCE_CHANGED', 409);
    return bundle;
  }
  return {
    list: (actorId: string) => runs.listForOwner(actorId),
    assertAvailable(config: EffectiveLaunchConfig) {
      const target = deploymentTargetSchema.parse(options.target(config));
      const repository = config.repository;
      const deployment = repository?.setup.integrations.deployment;
      if (
        !repository ||
        repository.config.provider !== 'github' ||
        deployment?.source !== 'published-default' ||
        target.id !== deployment.targetId ||
        target.repositoryId !== repository.id ||
        target.setupId !== repository.setup.id ||
        !deployment.allowedScripts?.length ||
        deployment.allowedScripts.some((s) => !target.allowedScripts.includes(s)) ||
        Object.keys(deployment.env).some((key) => !target.allowedEnv.includes(key))
      )
        configurationError(
          'Enroll a matching published-default deployment target and scripts',
          'DEPLOYMENT_TARGET_DENIED',
          409,
        );
    },
    async prepare(podId: string, raw: unknown, actorId?: string) {
      const request = deploymentRequestSchema.parse(raw);
      const context = selected(podId);
      if (actorId && actorId !== context.ownerId)
        configurationError(
          'Deployment belongs to another operator',
          'DEPLOYMENT_ACCESS_DENIED',
          403,
        );
      if (
        !context.target.allowedScripts.includes(request.scriptPath) ||
        !context.deployment.allowedScripts?.includes(request.scriptPath)
      )
        configurationError(
          'Deployment script is outside the selected allowlist',
          'DEPLOYMENT_SCRIPT_DENIED',
          403,
        );
      const existing = runs.find(podId, request.operationKey);
      if (existing) {
        bound(existing);
        if (
          existing.plan.scriptPath !== request.scriptPath ||
          configurationDigest(existing.plan.args) !== configurationDigest(request.args)
        )
          configurationError(
            'Deployment operation key was reused with different arguments',
            'DEPLOYMENT_REQUEST_CONFLICT',
            409,
          );
        return existing;
      }
      const published = await options.publishedDefault(context.repository.config);
      z.object({
        branch: z.string().min(1).max(256),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      }).parse(published);
      const bundle = await prepareDeploymentSource(
        await options.archive(context.repository.config, published.commit),
        request.scriptPath,
      );
      const runPlan = {
        ...request,
        podId,
        ownerId: context.ownerId,
        targetId: context.target.id,
        repositoryId: context.repository.id,
        setupId: context.repository.setup.id,
        launchDigest: context.config.digest,
        sourceKind: 'published-default',
        sourceBranch: published.branch,
        sourceCommit: published.commit,
        sourceDigest: bundle.sourceDigest,
        scriptDigest: bundle.scriptDigest,
        image: context.target.image,
        runnerDigest: configurationDigest(context.target),
        environmentDigest: configurationDigest({
          env: context.deployment.env,
          references: context.config.credentialReferences,
        }),
        credentialRevisions: options.credentialRevisions(context.config),
        expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString(),
      };
      // No credentials are resolved during preparation or review.
      const latest = selected(podId);
      if (
        latest.config.digest !== context.config.digest ||
        latest.ownerId !== context.ownerId ||
        configurationDigest(latest.target) !== runPlan.runnerDigest
      )
        configurationError(
          'Deployment selection changed during preparation',
          'DEPLOYMENT_PLAN_CHANGED',
          409,
        );
      // Concurrent retries may have won while source was fetched. Never replace their pinned commit.
      const concurrent = runs.find(podId, request.operationKey);
      if (concurrent) {
        bound(concurrent);
        if (
          concurrent.plan.scriptPath !== request.scriptPath ||
          configurationDigest(concurrent.plan.args) !== configurationDigest(request.args)
        )
          configurationError(
            'Deployment operation key was reused',
            'DEPLOYMENT_REQUEST_CONFLICT',
            409,
          );
        return concurrent;
      }
      return runs.reserve(runPlan);
    },
    status(podId: string, runId: string) {
      const run = runs.get(runId);
      if (run.plan.podId !== podId)
        configurationError('Deployment belongs to another pod', 'DEPLOYMENT_ACCESS_DENIED', 403);
      return run;
    },
    get(runId: string, actorId: string) {
      const run = runs.get(runId);
      owner(run, actorId);
      return run;
    },
    async review(runId: string, actorId: string) {
      const run = runs.get(runId);
      owner(run, actorId);
      const bundle = await source(run);
      return { run, scriptContent: bundle.scriptContent, target: bound(run).target };
    },
    async decide(runId: string, digest: string, actorId: string, decision: 'approve' | 'deny') {
      let run = runs.get(runId);
      owner(run, actorId);
      if (decision === 'deny') return runs.deny(runId, digest, actorId);
      if (run.digest !== digest)
        configurationError('Deployment approval digest differs', 'DEPLOYMENT_PLAN_CHANGED', 409);
      // Retried approval returns the durable outcome; it never repeats external effects.
      if (['running', 'completed', 'failed', 'uncertain', 'reconciled'].includes(run.state))
        return run;
      bound(run);
      run = runs.approve(runId, digest, actorId);
      if (
        !runs.claim(runId, digest, () => {
          bound(run);
        })
      )
        return runs.get(runId);
      const execute = async () => {
        try {
          const bundle = await source(run);
          const context = bound(run);
          const env = await options.credentials(context.config);
          bound(run);
          const receipt = await options.run(context.target, {
            runId,
            sourceTar: bundle.sourceTar,
            sourceDigest: run.plan.sourceDigest,
            scriptPath: run.plan.scriptPath,
            args: run.plan.args,
            env,
            assertCurrent: () => {
              bound(run);
            },
            recordContainer: (id) => runs.recordContainer(runId, id),
            recordExec: (identity) => runs.recordExec(runId, identity),
          });
          runs.finish(runId, receipt);
        } catch {
          // A lost acknowledgement cannot establish whether an external system changed.
          // Retain the target lock; never retry under another key or fall back to the host.
          runs.markUncertain(runId);
        }
      };
      const pending = execute()
        .catch(() => {
          // A database failure leaves the durable running claim for startup recovery.
        })
        .finally(() => {
          executions.delete(runId);
        });
      executions.set(runId, pending);
      return runs.get(runId);
    },
    async settled(runId: string) {
      await executions.get(runId);
      return runs.get(runId);
    },
    async reconcile(
      runId: string,
      digest: string,
      actorId: string,
      outcome: 'deployed' | 'not-deployed',
      note: string,
    ) {
      const run = runs.get(runId);
      owner(run, actorId);
      if (run.digest !== digest || run.state !== 'uncertain')
        configurationError(
          'Deployment is not awaiting reconciliation',
          'DEPLOYMENT_STATE_CONFLICT',
          409,
        );
      z.enum(['deployed', 'not-deployed']).parse(outcome);
      z.string().trim().min(1).max(2000).parse(note);
      await options.stop(run);
      return runs.reconcile(runId, digest, actorId, outcome, note);
    },
    async recover() {
      runs.recoverInterrupted();
      for (const run of runs.unresolved()) await options.stop(run);
      // Stopping containers proves process cleanup, not the outcome of a remote deployment.
    },
  };
}
export type DeploymentService = ReturnType<typeof createDeploymentService>;

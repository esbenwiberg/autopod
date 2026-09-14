import {
  AutopodError,
  type CreatePodRequest,
  type EffectiveLaunchConfig,
  type OperatorActor,
  type Pod,
  generatePodId,
  outputModeFromPodOptions,
} from '@autopod/shared';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import { dispatchRequestHash } from './dispatch-preflight-ledger.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import { findPreflightConflicts } from './preflight.js';
import { frozenReferenceBindings } from './reference-snapshots.js';

/** Inserts a composed launch directly. The enclosing snapshot transaction owns commit/dispatch. */
export function admitComposablePod(input: {
  config: EffectiveLaunchConfig;
  userId: string;
  creator?: { email?: string | null; name?: string | null };
  actor?: OperatorActor;
  pods: PodRepository;
  read(podId: string): EffectiveLaunchConfig | null;
  events: EventBus;
  enqueue(podId: string): void;
}): Pod {
  const { config, userId, pods } = input;
  const work = config.work;
  const options = launchPodOptions(config);
  const request: CreatePodRequest = {
    ...work,
    scheduledJobId: config.origin?.kind === 'schedule' ? config.origin.jobId : undefined,
    profileName: config.profileId,
    task: config.task,
    model: config.ai.main.model,
    runtime: config.ai.main.runtime,
    executionTarget: config.execution.target,
    options,
    requireSidecars: Object.keys(config.resolvedExecution.sidecars),
    autoApprove: config.workflow.completion === 'merge',
  };
  if (work.intentionalRerun) {
    if (input.actor?.type !== 'human' || input.actor.userId !== userId)
      throw new AutopodError(
        'Intentional rerun requires an authenticated human decision',
        'UNAUTHORIZED_RERUN',
        403,
      );
    if (!pods.dispatchPreflight)
      throw new AutopodError('Durable rerun admission unavailable', 'RERUN_UNAVAILABLE', 503);
    const existing = pods.dispatchPreflight.findRerun(request, userId);
    if (existing) return pods.getOrThrow(existing);
  }
  const parents = (work.dependsOnPodIds ?? []).map((id) => {
    const pod = pods.getOrThrow(id);
    const saved = input.read(id);
    if (!saved || saved.digest !== pod.launchConfigDigest)
      throw new AutopodError(
        'Dependencies require retained launch configuration',
        'CONFIG_SOURCE_MISSING',
        409,
      );
    if (saved.repository?.id !== config.repository?.id)
      throw new AutopodError(
        'Dependent pods must use the same enrolled repository',
        'DEPENDENCY_REPOSITORY_MISMATCH',
        409,
      );
    return pod;
  });
  const seriesParent = work.prMode === 'single' && work.seriesId ? parents[0] : undefined;
  if (seriesParent && work.branch !== undefined && work.branch !== seriesParent.branch)
    throw new AutopodError(
      'Single-PR series dependent must use its parent branch',
      'INVALID_CONFIGURATION',
      400,
    );
  const baseBranch =
    work.baseBranch ?? seriesParent?.baseBranch ?? config.repository?.setup.defaultBranch ?? 'main';
  const startBranch = work.startBranch ?? seriesParent?.startBranch ?? baseBranch;
  const conflicts = work.touches?.length
    ? findPreflightConflicts(
        {
          touches: work.touches,
          repoUrl: config.repository?.config.remote ?? null,
          baseBranch,
        },
        pods.listNonTerminal().map((pod) => {
          const saved = input.read(pod.id);
          if (!saved || saved.digest !== pod.launchConfigDigest)
            throw new AutopodError(
              'Active pod launch configuration is unavailable',
              'CONFIG_SOURCE_MISSING',
              409,
            );
          return { pod, repoUrl: saved.repository?.config.remote ?? null };
        }),
      )
    : [];
  if (conflicts.length && config.workflow.preflightConflictPolicy === 'block')
    throw new AutopodError(
      'Pod creation blocked: touches overlap in-flight pods',
      'PREFLIGHT_CONFLICT',
      409,
    );
  const account = config.agentAccounts[config.ai.main.providerAccountId];
  if (!account)
    throw new AutopodError('Launch account identity is missing', 'SNAPSHOT_CORRUPT', 500);
  let id = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    id = generatePodId();
    const prefix = config.workflow.branchPrefix;
    let branch =
      work.branch ??
      seriesParent?.branch ??
      (options.output === 'artifact' ? `research/${id}` : `${prefix}${id}`);
    if (options.agentMode === 'interactive' && !work.linkedPodId && branch === baseBranch)
      branch = `${prefix}${id}`;
    try {
      pods.insert({
        ...work,
        id,
        profileName: config.profileId,
        task: config.task,
        status: 'queued',
        model: config.ai.main.model,
        runtime: config.ai.main.runtime,
        providerAccountIdSnapshot: account.accountId,
        providerIdSnapshot: account.providerId,
        executionTarget: config.execution.target,
        branch,
        userId,
        creatorEmail: input.creator?.email ?? null,
        creatorName: input.creator?.name ?? null,
        maxValidationAttempts: config.workflow.maxValidationAttempts,
        skipValidation: false,
        dispatchRepository: config.repository?.config.remote,
        rerunRequestHash: work.intentionalRerun ? dispatchRequestHash(request) : undefined,
        options,
        outputMode: outputModeFromPodOptions(options),
        startBranch: startBranch !== baseBranch ? startBranch : null,
        baseBranch,
        handoffInstructions: work.handoffInstructions?.trim() || null,
        pimGroups: null,
        tokenBudget: config.workflow.tokenBudget,
        referenceRepos: frozenReferenceBindings(config),
        scheduledJobId: request.scheduledJobId,
        requireSidecars: request.requireSidecars,
        autoApprove: request.autoApprove,
      });
      break;
    } catch (error) {
      // Only an actual generated-ID collision is retryable; other uniqueness failures propagate.
      if (
        attempt < 9 &&
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed: pods.id')
      )
        continue;
      throw error;
    }
  }
  const pod = pods.getOrThrow(id);
  const publish = () => {
    input.events.emit({
      type: 'pod.created',
      timestamp: new Date().toISOString(),
      pod: {
        id: pod.id,
        profileName: pod.profileName,
        task: pod.task,
        status: pod.status,
        model: pod.model,
        runtime: pod.runtime,
        branch: pod.branch,
        baseBranch: pod.baseBranch,
        duration: null,
        filesChanged: pod.filesChanged,
        createdAt: pod.createdAt,
      },
    });
    if (conflicts.length)
      input.events.emit({
        type: 'pod.preflight_overlap',
        timestamp: new Date().toISOString(),
        podId: id,
        conflicts,
      });
    if (!parents.length) input.enqueue(id);
  };
  if (pods.afterInsertCommitted) pods.afterInsertCommitted(id, publish);
  else publish();
  return pod;
}

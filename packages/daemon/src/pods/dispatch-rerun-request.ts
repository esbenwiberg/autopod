import {
  AutopodError,
  type CreatePodRequest,
  type Pod,
  createPodRequestSchema,
} from '@autopod/shared';

/** Explicit new-task template. Do not inherit approval, waiver, delivery, or lineage. */
export function dispatchRerunRequest(pod: Pod): CreatePodRequest {
  if (pod.options.agentMode === 'interactive')
    throw new AutopodError(
      'Interactive workspaces require a new explicit task',
      'INVALID_RERUN',
      409,
    );
  const result = createPodRequestSchema.safeParse({
    profileName: pod.profileName,
    task: pod.task,
    contract: pod.contract ?? undefined,
    runtime: pod.runtime,
    model: pod.model,
    executionTarget: pod.executionTarget,
    baseBranch: pod.baseBranch ?? undefined,
    options: { ...pod.options, validate: true },
    specFiles: pod.specFiles ?? undefined,
    specContextFiles: pod.specContextFiles ?? undefined,
    referenceRepos: pod.referenceRepos ?? undefined,
    handoffInstructions: pod.handoffInstructions ?? undefined,
    requireSidecars: pod.requireSidecars ?? undefined,
  });
  if (!result.success)
    throw new AutopodError(
      `Historical request requires reconciliation before an intentional rerun: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      'RERUN_RECONCILIATION_REQUIRED',
      409,
    );
  return result.data;
}

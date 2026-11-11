import { AutopodError, type EffectiveLaunchConfig, type OperatorActor } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodRepository } from './pod-repository.js';
import { findPreflightConflicts } from './preflight.js';

/** A read-only, exact-resource observation. Only its synchronous recheck can exempt a conflict. */
export async function prepareIntentionalRerun(input: {
  config: EffectiveLaunchConfig;
  userId: string;
  actor?: OperatorActor;
  pods: PodRepository;
  read(podId: string): EffectiveLaunchConfig | null;
  manager: Pick<ContainerManager, 'getStatus'>;
  isIdle(podId: string): boolean;
}): Promise<(() => string) | undefined> {
  const rerun = input.config.work.intentionalRerun;
  if (!rerun || input.config.workflow.preflightConflictPolicy !== 'block') return undefined;
  const refuse = (): never => {
    throw new AutopodError(
      'Intentional rerun requires its exact failed source to be idle with a confirmed stopped local Docker resource; original evidence is retained.',
      'RERUN_SOURCE_NOT_QUIESCENT',
      409,
    );
  };
  const source = input.pods.getOrThrow(rerun.ofPodId);
  const sourceConfig = input.read(source.id);
  const overlaps = findPreflightConflicts(
    {
      touches: input.config.work.touches ?? [],
      repoUrl: input.config.repository?.config.remote ?? null,
      baseBranch:
        input.config.work.baseBranch ?? input.config.repository?.setup.defaultBranch ?? 'main',
    },
    [{ pod: source, repoUrl: sourceConfig?.repository?.config.remote ?? null }],
  );
  // Ordinary terminal/non-overlapping reruns retain their existing admission path.
  if (!overlaps.length) return undefined;
  const assertCurrent = (): string => {
    const current = input.pods.getOrThrow(source.id);
    if (
      input.actor?.type !== 'human' ||
      input.actor.userId !== input.userId ||
      source.userId !== input.userId ||
      current.status !== 'failed' ||
      current.lifecycleGeneration !== source.lifecycleGeneration ||
      current.updatedAt !== source.updatedAt ||
      current.containerId !== source.containerId ||
      current.launchConfigDigest !== source.launchConfigDigest ||
      current.executionTarget !== 'local' ||
      !current.containerId ||
      !/^[a-f0-9]{64}$/.test(current.containerId) ||
      current.prUrl ||
      current.linkedPodId ||
      (current.requireSidecars?.length ?? 0) > 0 ||
      current.options.agentMode !== 'auto' ||
      Object.keys(current.sidecarContainerIds ?? {}).length > 0 ||
      (current.testRunBranches?.length ?? 0) > 0 ||
      !input.isIdle(source.id) ||
      !source.launchConfigDigest ||
      input.read(source.id)?.digest !== source.launchConfigDigest ||
      input.read(source.id)?.intent !== 'task'
    )
      refuse();
    input.pods.assertRerunSourceAvailable(source.id);
    const task = input.pods.taskExecutions?.snapshot(source.id);
    if (!task || task.delivery.unresolvedCount > 0 || (task.merge?.requestCount ?? 0) > 0) refuse();
    return source.id;
  };
  assertCurrent();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      input.manager.getStatus(source.containerId as string),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Rerun source resource observation timed out')),
          10_000,
        );
      }),
    ]);
    if (status !== 'stopped' && status !== 'deleted') refuse();
  } catch {
    refuse();
  } finally {
    clearTimeout(timer);
  }
  assertCurrent();
  return assertCurrent;
}

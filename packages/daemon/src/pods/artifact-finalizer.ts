import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError, type Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import { retainFindings } from './research-findings.js';

const execFileAsync = promisify(execFile);

interface ArtifactFinalizerDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow' | 'update' | 'completionJournal' | 'atomically'>;
  getContainerManager(target: Pod['executionTarget']): ContainerManager;
  ownsArtifactCompletion(pod: Pod, allowRemovedContainer?: boolean): boolean;
  executionForPod(pod: Pod): PodExecutionSettings;
  syncSandboxSeriesHandover(podId: string): Promise<void>;
  resolveGitCredential(profile: PodExecutionSettings): Promise<string | undefined>;
  worktreeManager: Pick<WorktreeManager, 'create' | 'commitPendingChanges' | 'pushBranch'>;
  cleanupContainer(
    pod: Pod,
    label: string,
    mode: 'kill',
    assertReleaseAllowed: () => void,
  ): Promise<void>;
  assertExecutionTerminationVerified(podId: string): void;
  transition(pod: Pod, to: 'failed' | 'complete' | 'research_ready'): Pod;
  logger: Pick<Logger, 'error' | 'warn' | 'info'>;
  emitActivityStatus(podId: string, message: string): void;
  emitActivityError(podId: string, message: string, fatal: boolean): void;
}

/** Artifact delivery after manager admission; captured lifecycle/cycle remains authority. */
export function createArtifactFinalizer(deps: ArtifactFinalizerDependencies): {
  preserveArtifacts(pod: Pod): Promise<string>;
  finalizeArtifactPod(pod: Pod): Promise<void>;
} {
  const {
    podRepo,
    getContainerManager,
    ownsArtifactCompletion,
    executionForPod,
    syncSandboxSeriesHandover,
    resolveGitCredential,
    worktreeManager,
    cleanupContainer,
    transition,
    logger,
    emitActivityStatus,
    emitActivityError,
  } = deps;

  // Pause then Message can start a new worker cycle in the same generation/container.
  function ownsArtifactFinalization(pod: Pod, allowRemovedContainer = false): boolean {
    return (
      ownsArtifactCompletion(pod, allowRemovedContainer) &&
      (podRepo.getOrThrow(pod.id).finalization?.cycle ?? 0) === (pod.finalization?.cycle ?? 0)
    );
  }

  function assertArtifactFinalizationCurrent(pod: Pod): void {
    deps.assertExecutionTerminationVerified(pod.id);
    if (!ownsArtifactFinalization(pod))
      throw new AutopodError(
        'Artifact finalization was superseded; current resources retained.',
        'STALE_ARTIFACT_COLLECTION',
        409,
      );
  }

  async function preserveArtifacts(pod: Pod): Promise<string> {
    assertArtifactFinalizationCurrent(pod);
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
    const artifactRoot = path.join(dataDir, 'artifacts', pod.id);
    if (
      pod.finalization?.phase === 'preserving' &&
      pod.finalization.sourcePreservedAt &&
      pod.artifactsPath
    ) {
      await verifyArtifactSnapshot(
        pod.artifactsPath,
        artifactRoot,
        pod.lifecycleGeneration,
        pod.finalization.cycle,
      );
      if (!ownsArtifactFinalization(pod))
        throw new AutopodError(
          'Artifact finalization was superseded.',
          'STALE_ARTIFACT_COLLECTION',
          409,
        );
      return pod.artifactsPath;
    }
    podRepo.completionJournal?.mark(pod, 'preserving');
    emitActivityStatus(pod.id, 'Collecting artifacts…');
    try {
      const artifactsPath = await collectArtifactSnapshot({
        containerManager: getContainerManager(pod.executionTarget),
        containerId: pod.containerId,
        artifactRoot,
        generation: pod.lifecycleGeneration,
        cycle: pod.finalization?.cycle ?? 0,
        isCurrent: () => ownsArtifactFinalization(pod),
      });
      if (!ownsArtifactFinalization(pod))
        throw new AutopodError(
          'Artifact collection belongs to an older lifecycle; current resources retained.',
          'STALE_ARTIFACT_COLLECTION',
          409,
        );
      podRepo.update(pod.id, { artifactsPath });
      podRepo.completionJournal?.mark(pod, 'preserving', true);
      return artifactsPath;
    } catch (err) {
      logger.error({ err, podId: pod.id }, 'Artifact preservation failed; source retained');
      if (ownsArtifactFinalization(pod)) {
        const failureReason =
          'Artifact preservation failed. Original container retained; retry collection before completing.';
        podRepo.update(pod.id, { failureReason });
        emitActivityError(pod.id, failureReason, false);
      }
      throw err;
    }
  }

  async function finalizeArtifactPod(pod: Pod): Promise<void> {
    const podId = pod.id;
    if (!ownsArtifactFinalization(pod)) return;
    await syncSandboxSeriesHandover(podId);
    if (!ownsArtifactFinalization(pod)) return;
    deps.assertExecutionTerminationVerified(pod.id);
    const findingsOnly = pod.completionPolicy === 'accept-findings';
    const profile = executionForPod(pod);
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
    let artifactsPath: string;
    try {
      artifactsPath = await preserveArtifacts(pod);
    } catch {
      if (ownsArtifactFinalization(pod)) {
        transition(podRepo.getOrThrow(podId), 'failed');
      }
      return;
    }

    // Legacy research profiles selected a destination repository for publication.
    // Native artifact output only authorizes a preserved file snapshot; selecting
    // a source repository is not authorization to push an artifact branch.
    if (!findingsOnly && profile.repoUrl && !pod.launchConfigDigest) {
      const repoBranch = pod.branch ?? `research/${podId}`;
      try {
        emitActivityStatus(podId, 'Pushing artifact branch…');
        const tempWorktreeParent = path.join(dataDir, 'artifact-worktrees');
        await mkdir(tempWorktreeParent, { recursive: true });
        if (!ownsArtifactFinalization(pod)) return;
        const pat = await resolveGitCredential(profile);
        if (!ownsArtifactFinalization(pod)) return;
        const worktreeResult = await worktreeManager.create({
          repoUrl: profile.repoUrl,
          branch: repoBranch,
          baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
          pat,
        });
        if (!ownsArtifactFinalization(pod)) return;
        // Copy artifacts into the worktree (cp -a copies contents, trailing /. required)
        await execFileAsync('cp', ['-a', `${artifactsPath}/.`, `${worktreeResult.worktreePath}/`]);
        if (!ownsArtifactFinalization(pod)) return;
        await worktreeManager.commitPendingChanges(
          worktreeResult.worktreePath,
          `research: ${pod.task.slice(0, 72)}`,
          { maxDeletions: 1000 },
        );
        if (!ownsArtifactFinalization(pod)) return;
        await worktreeManager.pushBranch(worktreeResult.worktreePath, repoBranch);
        logger.info({ podId, branch: repoBranch }, 'Artifact branch pushed');
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to push artifact branch — artifacts available via API');
      }
    }

    const findings = findingsOnly ? await retainFindings(podRepo.getOrThrow(podId)) : null;

    // Release only after receipt verification and task-wide termination checks.
    if (!ownsArtifactFinalization(pod)) return;
    try {
      await cleanupContainer(pod, 'artifact-complete', 'kill', () =>
        assertArtifactFinalizationCurrent(pod),
      );
    } catch (err) {
      if (err instanceof AutopodError && err.code === 'STALE_ARTIFACT_COLLECTION') return;
      throw err;
    }
    if (!ownsArtifactFinalization(pod, true)) return;
    deps.assertExecutionTerminationVerified(podId);
    atomicPodChange(podRepo, () => {
      if (findings) podRepo.update(podId, { researchFindings: findings });
      transition(podRepo.getOrThrow(podId), findingsOnly ? 'research_ready' : 'complete');
    });
  }

  return { preserveArtifacts, finalizeArtifactPod };
}

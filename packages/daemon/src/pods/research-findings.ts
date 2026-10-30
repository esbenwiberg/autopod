import { createHash } from 'node:crypto';
import path from 'node:path';
import { AutopodError, type OperatorActor, type Pod } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import {
  fingerprintArtifactSnapshot,
  verifyArtifactSnapshot,
} from './artifact-snapshot-receipt.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';

export interface AcceptFindingsRequest {
  expectedGeneration: number;
  expectedCycle: number;
  expectedEvidenceHash: string;
}

function conflict(message: string): never {
  throw new AutopodError(message, 'FINDINGS_CONFLICT', 409);
}

export async function retainFindings(pod: Pod): Promise<NonNullable<Pod['researchFindings']>> {
  if (
    !pod.launchConfigDigest ||
    !pod.taskSummary ||
    !pod.finalization?.agentSettledAt ||
    pod.finalization.generation !== pod.lifecycleGeneration ||
    !pod.artifactsPath
  )
    conflict('A durable native summary, settled worker and artifact receipt are required');
  const root = path.join(
    process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
    'artifacts',
    pod.id,
  );
  await verifyArtifactSnapshot(
    pod.artifactsPath,
    root,
    pod.lifecycleGeneration,
    pod.finalization.cycle,
  );
  const snapshot = await fingerprintArtifactSnapshot(pod.artifactsPath);
  const identity = {
    generation: pod.lifecycleGeneration,
    cycle: pod.finalization.cycle,
    configDigest: pod.launchConfigDigest,
    summary: pod.taskSummary,
    result: pod.finalization.result,
    artifactsPath: pod.artifactsPath,
    snapshotHash: snapshot.sha256,
  };
  return {
    ...identity,
    evidenceHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    readyAt: new Date().toISOString(),
    acceptance: null,
  };
}

export function createFindingsAcceptance(deps: {
  podRepo: PodRepository;
  assertExecutionTerminationVerified(id: string): void;
  assertGuidanceCollected(id: string): void;
  transition(pod: Pod, to: 'complete', updates?: Partial<PodUpdates>): Pod;
  emitPodCompletedEvent(pod: Pod): void;
  maybeTriggerDependents(id: string): void;
}) {
  return async function acceptFindings(
    id: string,
    request: AcceptFindingsRequest,
    actor: OperatorActor,
  ) {
    if (actor.type !== 'human')
      throw new AutopodError('Human acceptance is required', 'HUMAN_REQUIRED', 403);
    const pod = deps.podRepo.getOrThrow(id);
    const receipt = pod.researchFindings;
    const assertCurrent = () => {
      deps.assertExecutionTerminationVerified(id);
      deps.assertGuidanceCollected(id);
      const current = deps.podRepo.getOrThrow(id);
      if (
        current.completionPolicy !== 'accept-findings' ||
        !receipt ||
        current.lifecycleGeneration !== request.expectedGeneration ||
        receipt.generation !== request.expectedGeneration ||
        receipt.cycle !== request.expectedCycle ||
        receipt.evidenceHash !== request.expectedEvidenceHash ||
        current.researchFindings?.evidenceHash !== receipt.evidenceHash ||
        current.launchConfigDigest !== receipt.configDigest ||
        current.finalization?.cycle !== receipt.cycle ||
        JSON.stringify(current.taskSummary) !== JSON.stringify(receipt.summary) ||
        current.finalization.result !== receipt.result ||
        current.artifactsPath !== receipt.artifactsPath ||
        current.pendingEscalation ||
        deps.podRepo.hasUnansweredDecision?.(id) ||
        !['research_ready', 'complete'].includes(current.status)
      )
        conflict(
          'Findings changed or are no longer ready; refresh and review the current evidence',
        );
      return current;
    };
    assertCurrent();
    const verified = await retainFindings(pod);
    if (verified.evidenceHash !== receipt?.evidenceHash)
      conflict('Retained evidence differs from the reviewed findings');
    return atomicPodChange(deps.podRepo, () => {
      const current = assertCurrent();
      if (current.status === 'complete' && current.researchFindings?.acceptance)
        return current.researchFindings;
      if (current.status !== 'research_ready') conflict('Findings are not awaiting acceptance');
      const acceptedAt = new Date().toISOString();
      const accepted = { ...verified, readyAt: receipt.readyAt, acceptance: { actor, acceptedAt } };
      const completed = deps.transition(current, 'complete', {
        researchFindings: accepted,
        completedAt: acceptedAt,
      });
      const publish = () => {
        deps.emitPodCompletedEvent(completed);
        deps.maybeTriggerDependents(id);
      };
      if (deps.podRepo.afterCommit) deps.podRepo.afterCommit(publish);
      else publish();
      return accepted;
    });
  };
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { AutopodError, type Pod } from '@autopod/shared';
import type { ContainerManager, WorktreeManager } from '../interfaces/index.js';
import { APPROVAL_SNAPSHOT_EXCLUDES } from './approval-policy.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import { verifyApprovalSnapshotBinding } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import { ValidationSupersededError } from './validation-ownership.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

// Optimization only: the private on-disk receipt survives restart. Approval joins
// a pre-stop export rather than racing it with another export and suspension.
const pending = new WeakMap<
  PodRepository,
  Map<string, { selection: string; run: Promise<void> }>
>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selection = (pod: Pod) =>
  hash([
    'approval-reports-v1',
    pod.id,
    pod.lifecycleGeneration,
    pod.finalization?.cycle ?? 0,
    pod.containerId,
    pod.executionTarget,
    pod.worktreePath,
    pod.branch,
    pod.baseBranch,
    pod.runtime,
    pod.model,
    pod.providerIdSnapshot,
    pod.providerAccountIdSnapshot,
    pod.profileSnapshot,
    pod.contract,
    pod.options,
    pod.lastValidationResult,
  ]);

export const approvalArtifactRoot = (podId: string) =>
  path.join(process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'), 'artifacts', podId);

export function approvalReportPreservationFailure(error: unknown): string {
  const detail =
    error instanceof AutopodError &&
    (error.code.startsWith('SANDBOX_WAKEUP_') || error.code === 'APPROVAL_REPORT_SOURCE_UNVERIFIED')
      ? error.message
      : 'Workspace reports could not be preserved before stop. Original sandbox retained; retry approval to collect reports.';
  return `Approval delivery failed. ${detail}`;
}

export function needsApprovalReportSnapshot(pod: Pod): boolean {
  return (
    pod.executionTarget === 'sandbox' &&
    !!pod.containerId &&
    (pod.options.output === 'pr' || pod.options.output === 'branch')
  );
}

interface SnapshotContext {
  pod: Pod;
  podRepo: PodRepository;
  worktreeManager: WorktreeManager;
  assertCurrent(): void;
}

function snapshotGuard(input: SnapshotContext) {
  const expected = selection(input.pod);
  return () => {
    input.assertCurrent();
    assertValidationMutationSettled(input.podRepo, input.pod.id);
    const current = input.podRepo.getOrThrow(input.pod.id);
    if (current.status !== 'validated' || selection(current) !== expected)
      throw new ValidationSupersededError();
  };
}

async function sourceBinding(input: SnapshotContext, assertCurrent: () => void) {
  assertCurrent();
  const pod = input.pod;
  const source =
    pod.worktreePath && (await input.worktreeManager.inspectSource?.(pod.worktreePath, pod.branch));
  assertCurrent();
  if (
    pod.lastValidationResult?.overall !== 'pass' ||
    !source ||
    !source.worktreeClean ||
    source.branch !== pod.branch ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitSha) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.treeSha)
  )
    throw new AutopodError(
      'Approval report source identity is unavailable or dirty. Original resources retained.',
      'APPROVAL_REPORT_SOURCE_UNVERIFIED',
      409,
    );
  return hash([selection(pod), source.commitSha, source.treeSha]);
}

export async function waitForApprovalReportSnapshot(repo: PodRepository, podId: string) {
  await pending.get(repo)?.get(podId)?.run;
}

/** Capture after advisory has settled, before any intentional suspension/cleanup. */
export function preserveApprovalReportSnapshot(
  input: SnapshotContext & {
    containerManager: ContainerManager;
    onStage?: (stage: 'wakeup' | 'export') => void;
  },
): Promise<void> {
  let runs = pending.get(input.podRepo);
  if (!runs) {
    runs = new Map();
    pending.set(input.podRepo, runs);
  }
  const existing = runs.get(input.pod.id);
  if (existing)
    return existing.selection === selection(input.pod)
      ? existing.run
      : Promise.reject(new ValidationSupersededError());
  const assertCurrent = snapshotGuard(input);
  const operation = (async () => {
    const binding = await sourceBinding(input, assertCurrent);
    const snapshot = await collectArtifactSnapshot({
      containerManager: input.containerManager,
      containerId: input.pod.containerId,
      artifactRoot: approvalArtifactRoot(input.pod.id),
      generation: input.pod.lifecycleGeneration,
      cycle: input.pod.finalization?.cycle ?? 0,
      approvalBinding: binding,
      isCurrent: () => {
        assertCurrent();
        return true;
      },
      excludes: APPROVAL_SNAPSHOT_EXCLUDES,
      wakeupTimeoutMs: 150_000,
      onStage: input.onStage,
    }).catch((error: unknown) => {
      // Keep supersession distinct from a copy failure even when the collector
      // wrapped a stale callback. A newer result must not get parked or stopped.
      assertCurrent();
      throw error;
    });
    if ((await sourceBinding(input, assertCurrent)) !== binding)
      throw new AutopodError(
        'Source changed during report preservation. Original resources retained.',
        'APPROVAL_REPORT_SOURCE_UNVERIFIED',
        409,
      );
    assertCurrent();
    input.podRepo.update(input.pod.id, { artifactsPath: snapshot });
  })();
  const run = operation.finally(() => {
    if (runs.get(input.pod.id)?.run === run) runs.delete(input.pod.id);
  });
  runs.set(input.pod.id, { selection: selection(input.pod), run });
  return run;
}

/** No provider call: reuse only exact current source/result/resource and intact reports. */
export async function verifiedApprovalReportSnapshot(
  input: SnapshotContext,
): Promise<string | null> {
  const snapshot = input.pod.artifactsPath;
  if (!snapshot) return null;
  // A saved report is not provider readiness or settlement of a later unknown
  // resume. Fall back to the original observation-only wakeup protocol.
  if (input.pod.containerId && input.podRepo.sandboxWakeups?.retains(input.pod.containerId))
    return null;
  const assertCurrent = snapshotGuard(input);
  const binding = await sourceBinding(input, assertCurrent);
  const matches = await verifyApprovalSnapshotBinding(
    snapshot,
    approvalArtifactRoot(input.pod.id),
    input.pod.lifecycleGeneration,
    input.pod.finalization?.cycle ?? 0,
    binding,
  );
  assertCurrent();
  if ((await sourceBinding(input, assertCurrent)) !== binding)
    throw new AutopodError(
      'Source changed during report verification. Original resources retained.',
      'APPROVAL_REPORT_SOURCE_UNVERIFIED',
      409,
    );
  return matches ? snapshot : null;
}

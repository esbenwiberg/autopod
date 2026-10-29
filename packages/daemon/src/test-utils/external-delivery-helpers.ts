import { vi } from 'vitest';
import type { PrManager, PrMergeStatus } from '../interfaces/pr-manager.js';
import { createApprovalDeliveryExecution } from '../pods/approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from '../pods/approval-delivery-preparation.js';
import { createApprovalWorkflow } from '../pods/approval-workflow.js';
import { createApprovalFixture } from './approval-helpers.js';

export function createExternalDeliveryFixture(disk = false) {
  const f = createApprovalFixture(disk);
  f.podRepo.update('prepare', { executionTarget: 'sandbox' });
  f.validated();
  f.podRepo.update('prepare', { prUrl: 'https://github.com/org/repo/pull/27' });
  const profile = f.mainCaptured.executionForPod(f.pod());
  const target = {
    repository: profile.repoUrl,
    branch: f.pod().branch,
    baseBranch: profile.defaultBranch,
  };
  const source = {
    branch: f.pod().branch,
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    worktreeClean: true,
  };
  f.worktreeManager.inspectSource = vi.fn(async () => ({ ...source }));
  const status: PrMergeStatus = {
    merged: true,
    open: false,
    sourceTarget: target,
    headSha: source.commitSha,
    blockReason: null,
    ciFailures: [],
    reviewComments: [],
  };
  const provider = {
    getPrStatus: vi.fn<PrManager['getPrStatus']>(async () => ({ ...status })),
    createPr: vi.fn<PrManager['createPr']>(async () => ({ url: '', usedFallback: false })),
    mergePr: vi.fn<PrManager['mergePr']>(async () => ({ merged: true, autoMergeScheduled: false })),
  } satisfies PrManager;
  const captured = { ...f.mainCaptured, prManagerFactory: vi.fn(() => provider) };
  const workflow = () =>
    createApprovalWorkflow({
      ...captured,
      ...createApprovalDeliveryPreparation(captured),
      ...createApprovalDeliveryExecution(captured),
    });
  const approve = () =>
    workflow().approveSession('prepare', {
      actor: { type: 'human', userId: 'operator' },
      reason:
        'Recognize the exact externally merged task source; keep original reports pending and sandbox retained.',
    });
  return { ...f, provider, captured, workflow, approve, source, target, status };
}

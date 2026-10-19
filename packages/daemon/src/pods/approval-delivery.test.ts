import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import type { ApprovalPreparationContext } from './delivery-contracts.js';
async function input(
  f: ReturnType<typeof createDeliveryFixture>,
): Promise<ApprovalPreparationContext> {
  const pod = f.pod();
  return {
    podId: 'prepare',
    pod,
    options: {},
    readiness: await f.context.resolveApprovalReadiness(pod, { waitForAdvisory: true }),
    actor: { type: 'automation', id: 'direct-pod-manager' },
    approvalReason: undefined,
  };
}
describe('approval delivery stages', () => {
  it('recognizes a prior source-bound merge during preparation without republishing it', async () => {
    const f = createDeliveryFixture();
    const planned = await f.planMerge();
    f.podRepo.update('prepare', { status: 'validated' });
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        merged: true,
        open: false,
        headSha: planned.publication.commitSha,
        sourceTarget: {
          repository: planned.publication.repository,
          branch: 'branch',
          baseBranch: 'main',
        },
      }),
    );
    const prepared = await createApprovalDeliveryPreparation({
      ...f.mainCaptured,
      prManagerFactory: () => f.provider,
    }).prepareApprovalDelivery(await input(f));
    expect(prepared).toMatchObject({ kind: 'ready', recoveredMerge: true });
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledOnce();
  });
  it('fences a replacement lifecycle after execution returns and before final cleanup', async () => {
    const f = createDeliveryFixture();
    const preparation = createApprovalDeliveryPreparation(f.mainCaptured);
    const execution = createApprovalDeliveryExecution(f.mainCaptured);
    const execute: typeof execution.executeApprovalDelivery = async (context) => {
      const result = await execution.executeApprovalDelivery(context);
      f.podRepo.incrementLifecycleGeneration('prepare');
      return result;
    };
    const entry = createApprovalWorkflow({
      ...f.mainCaptured,
      ...preparation,
      executeApprovalDelivery: execute,
    });
    await expect(entry.approveSession('prepare')).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(f.pod().status).toBe('merging');
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledOnce();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
  it('returns halted only after the no-change lifecycle completed and dependent effects ran', async () => {
    const f = createDeliveryFixture();
    vi.mocked(f.worktreeManager.getDiffStats).mockResolvedValueOnce({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    if (!f.worktreeManager.hasChangesAgainstBase) throw new Error('Missing native fixture method');
    vi.mocked(f.worktreeManager.hasChangesAgainstBase).mockResolvedValueOnce(false);
    await expect(
      createApprovalDeliveryPreparation(f.mainCaptured).prepareApprovalDelivery(await input(f)),
    ).resolves.toEqual({ kind: 'halted' });
    expect(f.pod().status).toBe('complete');
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.maybeTriggerDependents).toHaveBeenCalledOnce();
  });
  it('returns the two publication closures without publishing changed source during preparation', async () => {
    const f = createDeliveryFixture();
    const prepared = await createApprovalDeliveryPreparation(
      f.mainCaptured,
    ).prepareApprovalDelivery(await input(f));
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Unexpected halt');
    expect(prepared.recoveredMerge).toBe(false);
    expect(prepared.publishApprovalBranch).toBeTypeOf('function');
    expect(prepared.commitAndPublishApprovalBranch).toBeTypeOf('function');
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('validated');
  });
  it('returns halted for review-pending delivery, preserving the source intent and original poll callback', async () => {
    const f = createDeliveryFixture();
    f.podRepo.update('prepare', { prUrl: 'https://github.com/org/repo/pull/27' });
    f.provider.getPrStatus.mockResolvedValue(pendingStatus({ reviewDecision: 'REVIEW_REQUIRED' }));
    const captured = { ...f.mainCaptured, prManagerFactory: () => f.provider };
    const context = await input(f);
    const prepared =
      await createApprovalDeliveryPreparation(captured).prepareApprovalDelivery(context);
    if (prepared.kind !== 'ready') throw new Error('Unexpected halt');
    const approved = f.events.transition(context.pod, 'approved');
    const merging = f.events.transition(approved, 'merging');
    const output = await createApprovalDeliveryExecution(captured).executeApprovalDelivery({
      podId: 'prepare',
      pod: context.pod,
      options: {},
      mergingAnchor: { ...context.pod, status: 'merging' },
      s2: merging,
      ...prepared,
    });
    expect(output).toEqual({ kind: 'halted' });
    expect(f.pod().status).toBe('merge_pending');
    expect(f.podRepo.mergeJournal?.find(f.pod())?.state).toBe('planned');
    expect(f.mainCaptured.startMergePolling).toHaveBeenCalledWith('prepare');
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
  it('rejects a replacement lifecycle between prepared stage return and normal approval admission', async () => {
    const f = createDeliveryFixture();
    const preparation = createApprovalDeliveryPreparation(f.mainCaptured);
    const execute = createApprovalDeliveryExecution(f.mainCaptured);
    const prepare = async (context: ApprovalPreparationContext) => {
      const result = await preparation.prepareApprovalDelivery(context);
      f.podRepo.incrementLifecycleGeneration('prepare');
      return result;
    };
    const entry = createApprovalWorkflow({
      ...f.mainCaptured,
      ...execute,
      prepareApprovalDelivery: prepare,
    });
    await expect(entry.approveSession('prepare')).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(f.pod().status).toBe('validated');
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
});

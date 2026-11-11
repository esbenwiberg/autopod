import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { validationRecoveryRoutes } from '../api/routes/validation-recovery.js';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { terminationAuth } from '../test-utils/termination-reconciliation-helpers.js';
import { publishSource } from '../worktrees/durable-source-publication.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { reconcileApprovalRewritesOnStartup } from './approval-rewrite-reconciliation.js';
import { prepareApprovalRewrite } from './approval-source-rewrite.js';
import { createApprovalSourceRewriteRepository } from './approval-source-rewrite-repository.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import { retainUnresolvedReconciliation } from './reconciliation-ownership.js';

const head = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const base = 'e'.repeat(40);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const f = createDeliveryFixture(true);
  vi.stubEnv('DATA_DIR', path.join(f.directory, 'data'));
  f.podRepo.update('prepare', {
    options: { ...f.pod().options, output: 'pr' },
    prUrl: 'https://github.com/org/repo/pull/27',
    autoApprove: true,
    validationAttempts: 2,
  });
  const captured = { ...f.mainCaptured, prManagerFactory: () => f.provider };
  const workflow = () =>
    createApprovalWorkflow({
      ...captured,
      ...createApprovalDeliveryPreparation(captured),
      ...createApprovalDeliveryExecution(captured),
    });
  const approve = () =>
    workflow().approveSession('prepare', { actor: { type: 'human', userId: 'operator' } });
  if (!f.worktreeManager.prepareApprovalRebase) throw new Error('Missing fixture method');
  vi.mocked(f.worktreeManager.prepareApprovalRebase).mockImplementation(async (config) => {
    config.onPrepared(base);
    return {
      kind: 'candidate',
      baseCommitSha: base,
      worktreePath: path.join(config.root, 'worktree'),
      head,
      tree,
    };
  });
  return {
    ...f,
    captured,
    workflow,
    approve,
    prepareRebase: vi.mocked(f.worktreeManager.prepareApprovalRebase),
  };
}

describe('approval source rewrite custody', () => {
  it('queues isolated checks without publishing the candidate, resetting budgets or restarting an agent', async () => {
    const f = fixture();
    f.podRepo.update('prepare', {
      lastRecoveryTrigger: 'wake',
      lastCorrectionMessage: 'Historical wake recovery',
    });
    const original = f.pod();
    await f.approve();
    const pod = f.pod();
    const row = f.podRepo.approvalRewrites?.latest(pod);
    expect(pod).toMatchObject({
      status: 'queued',
      lifecycleGeneration: original.lifecycleGeneration + 1,
      skipAgent: true,
      autoApprove: false,
      containerId: null,
      lastValidationResult: null,
      lastRecoveryTrigger: null,
      lastCorrectionMessage: null,
      validationAttempts: 2,
      maxValidationAttempts: original.maxValidationAttempts,
    });
    expect(row).toMatchObject({
      prepared: { head, tree, worktreePath: pod.worktreePath },
      activated: { generation: pod.lifecycleGeneration },
    });
    expect(row?.binding.predecessor.commitSha).not.toBe(head);
    const inspection = f.manager().getApprovalSourceRewrite?.('prepare');
    expect(inspection).toMatchObject({
      phase: 'checking',
      checks: 'pending',
      candidateHeadSha: head,
      originalResources: 'retained',
    });
    expect(JSON.stringify(inspection)).not.toContain(f.directory);
    expect(f.captured.enqueueSession).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledOnce(); // original source only
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    expect(f.captured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.podRepo.approvalRewrites?.retains(original.containerId ?? '')).toBe(true);
    expect(() => f.podRepo.delete('prepare')).toThrow();
    expect(() => f.db.prepare("UPDATE approval_source_rewrites SET binding='{}'").run()).toThrow(
      'immutable',
    );
    expect(() => f.db.prepare('DELETE FROM approval_source_rewrite_events').run()).toThrow(
      'immutable',
    );
    const next = f.reopen();
    expect(next.pods.approvalRewrites?.latest(next.pods.getOrThrow('prepare'))).toEqual(row);
  });

  it.each([
    'preparing',
    'checks-held',
    'aborted',
  ] as const)('reports ordinary recovery eligibility consistently with %s rewrite custody', async (phase) => {
    const f = fixture();
    if (phase !== 'checks-held') {
      f.prepareRebase.mockImplementation(async (config) => {
        config.onPrepared(base);
        throw new Error('Preparation interrupted');
      });
      await expect(f.approve()).rejects.toThrow();
    } else await f.approve();
    const rewrite = f.podRepo.approvalRewrites?.latest(f.pod());
    if (!rewrite) throw new Error('Missing rewrite');
    if (phase === 'aborted')
      f.podRepo.approvalRewrites?.append(rewrite.id, 'aborted', { reason: 'Preparation refused' });
    f.podRepo.update('prepare', {
      status: 'review_required',
      containerId: 'checks-resource',
      lastValidationResult: { ...f.passContext().result, overall: 'fail' },
    });
    const before = f.pod();
    const manager = f.manager();
    const repair = vi.spyOn(manager, 'triggerValidation').mockResolvedValue();
    const retry = vi
      .spyOn(manager, 'revalidateSession')
      .mockResolvedValue({ newCommits: false, result: 'fail' });
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    validationRecoveryRoutes(app, manager);
    const headers = { authorization: 'Bearer human-token' };
    const url = '/pods/prepare/validation-recovery';
    try {
      const state = (await app.inject({ url, headers })).json();
      for (const [action, availability] of [
        ['fix-validation', state.fixValidation],
        ['retry-checks', state.retryChecks],
      ] as const) {
        if (phase === 'aborted') {
          expect(availability).toEqual({ allowed: true });
          continue;
        }
        expect(availability).toMatchObject({
          allowed: false,
          code: 'DELIVERY_RECONCILIATION_REQUIRED',
          reason: expect.stringContaining('ap source-recovery prepare --json'),
        });
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            action,
            expectedGeneration: before.lifecycleGeneration,
            expectedValidationTimestamp: before.lastValidationResult?.timestamp,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toBe(availability.code);
      }
      expect(repair).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(f.pod()).toEqual(before);
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(f.provider.mergePr).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('retains an admitted preparation failure across retry without repeating the rebase', async () => {
    const f = fixture();
    f.prepareRebase.mockImplementation(async (config) => {
      config.onPrepared(base);
      throw new Error('Process interrupted while preparing isolated candidate');
    });
    await expect(f.approve()).rejects.toThrow();
    expect(f.pod().status).toBe('validated');
    expect(f.podRepo.approvalRewrites?.latest(f.pod())?.prepared).toBeUndefined();
    await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    expect(f.worktreeManager.prepareApprovalRebase).toHaveBeenCalledOnce();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });

  it('returns to new human approval after source-bound checks, preserving the original lease across DB reopen', async () => {
    const f = fixture();
    await f.approve();
    f.podRepo.update('prepare', { status: 'validating', containerId: 'checks-resource' });
    f.worktreeManager.inspectSourceAdoption = vi.fn(async () => ({
      branch: f.pod().branch,
      commitSha: head,
      treeSha: tree,
      worktreeClean: true,
    }));
    const context = f.passContext();
    context.result.taskReview = {
      status: 'pass',
      reasoning: 'Independent review passed',
      issues: [],
      model: 'fixture',
    };
    f.podRepo.update('prepare', { lastValidationResult: context.result });
    context.s2 = f.pod();
    context.pod = f.pod();
    await f.pass().completeValidationPass.call(f.calls, context);
    expect(f.pod().status).toBe('validated');
    expect(f.podRepo.approvalRewrites?.assertDelivery(f.pod())?.checked).toMatchObject({
      head,
      tree,
    });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.passCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
    expect(f.calls.approveSession).not.toHaveBeenCalled();
    await expect(
      f.pass().completeValidationPass.call(f.calls, f.passContext()),
    ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    const record = createApprovalSourceRewriteRepository(f.db).latest(f.pod());
    expect(record?.checked).toBeDefined();
    await expect(
      f.workflow().approveSession('prepare', { automation: true }),
    ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });

    // A new approval publishes exactly this checked candidate using the original
    // predecessor, not the current remote or an ephemeral process allowance.
    f.worktreeManager.inspectSource = vi.fn(async () => ({
      branch: f.pod().branch,
      commitSha: head,
      treeSha: tree,
      worktreeClean: true,
    }));
    vi.mocked(f.worktreeManager.pushBranch).mockImplementation(
      async (_worktree, branch, options) => {
        const receipt = {
          branch,
          repository: 'https://github.com/org/repo',
          commitSha: head,
          treeSha: tree,
          remoteRef: `refs/heads/${branch}`,
          observedRemoteCommitSha: head,
          worktreeClean: true as const,
          observedAt: new Date().toISOString(),
        };
        options?.onPrepared?.(receipt);
        return receipt;
      },
    );
    f.prepareRebase.mockResolvedValue({
      kind: 'unchanged',
      baseCommitSha: base,
    });
    f.provider.getPrStatus.mockResolvedValue(pendingStatus());
    await f.approve();
    expect(f.worktreeManager.pushBranch).toHaveBeenLastCalledWith(
      expect.any(String),
      f.pod().branch,
      expect.objectContaining({
        force: true,
        expectedRemoteCommitSha: record?.binding.predecessor.commitSha,
      }),
    );
  });

  it('recovers a prepared candidate after interrupted approval without repeating its rebase', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { status: 'merging' });
    const pod = f.pod();
    const ledger = f.podRepo.sourcePublications;
    if (!ledger) throw new Error('Missing source ledger');
    const publication = await publishSource(
      ledger,
      pod,
      f.captured.executionForPod(pod).repoUrl,
      f.worktreeManager,
    );
    const id = await prepareApprovalRewrite(f.captured, pod, publication, 'main', undefined);
    const prepared = id ? f.podRepo.approvalRewrites?.get(id)?.prepared : undefined;
    if (!prepared) throw new Error('Missing prepared candidate');
    expect(reconcileApprovalRewritesOnStartup(f.podRepo)).toEqual(['prepare']);
    expect(f.pod().status).toBe('validated');
    const inspect = f.worktreeManager.inspectSource;
    if (!inspect) throw new Error('Missing inspector');
    f.worktreeManager.inspectSource = vi.fn(async (worktree, branch) =>
      worktree === prepared.worktreePath
        ? { branch, commitSha: head, treeSha: tree, worktreeClean: true }
        : inspect(worktree, branch),
    );
    await f.approve();
    expect(f.pod().status).toBe('queued');
    expect(f.prepareRebase).toHaveBeenCalledOnce();
    expect(f.captured.enqueueSession).toHaveBeenCalledOnce();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });

  it('retains an interrupted candidate checks invocation instead of requeueing a coding agent', async () => {
    const f = fixture();
    await f.approve();
    f.podRepo.update('prepare', {
      status: 'running',
      containerId: 'checks-resource',
      skipAgent: false,
    });
    const before = f.pod();
    expect(retainUnresolvedReconciliation('prepare', f.podRepo)).toBe(true);
    expect(f.pod()).toMatchObject({
      status: 'running',
      lifecycleGeneration: before.lifecycleGeneration,
      containerId: 'checks-resource',
    });
    expect(f.pod().lastCorrectionMessage).toContain('does not authorize a coding agent');
    expect(f.manager().getApprovalSourceRewrite?.('prepare')?.phase).toBe('checks-held');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('does not publish over a prior-generation unknown/scheduled merge (scheduled: %s)', async (scheduled) => {
    const f = fixture();
    const previous = await f.planMerge();
    const journal = f.podRepo.mergeJournal;
    if (!journal) throw new Error('Missing merge journal');
    const attempt = journal.claim(
      f.pod(),
      f.pod(),
      previous.publication.publicationId,
      previous.entry.request.config,
    );
    if (scheduled)
      journal.observe(attempt, { merged: false, autoMergeScheduled: true }, 'merge_response');
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { status: 'validated' });
    vi.mocked(f.worktreeManager.pushBranch).mockClear();
    await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.prepareRebase).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('validated');
  });

  it('does not certify changed candidate bytes as a successful rewrite', async () => {
    const f = fixture();
    await f.approve();
    f.podRepo.update('prepare', { status: 'validating', containerId: 'checks-resource' });
    f.worktreeManager.inspectSourceAdoption = vi.fn(async () => ({
      branch: f.pod().branch,
      commitSha: head,
      treeSha: 'f'.repeat(40),
      worktreeClean: true,
    }));
    await expect(f.pass().completeValidationPass.call(f.calls, f.passContext())).rejects.toThrow();
    expect(f.podRepo.approvalRewrites?.latest(f.pod())?.checked).toBeUndefined();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  });
});

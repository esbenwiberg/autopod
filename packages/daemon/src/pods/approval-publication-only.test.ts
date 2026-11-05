import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { createApprovalWorkflow } from './approval-workflow.js';

const validStatus = (overrides: Parameters<typeof pendingStatus>[0] = {}) =>
  pendingStatus({
    headSha: 'a'.repeat(40),
    sourceTarget: {
      repository: 'https://github.com/org/repo',
      branch: 'branch',
      baseBranch: 'main',
    },
    ...overrides,
  });

// Unit-level admission projection and provider doubles. The real retained-source
// checks/report/ownership contracts are exercised separately by continuation tests.
function fixture(existingPr = true, admit = true) {
  const f = createDeliveryFixture(true);
  f.podRepo.update('prepare', {
    prUrl: existingPr ? 'https://github.com/org/repo/pull/27' : null,
    options: { ...f.pod().options, output: 'pr' },
    autoApprove: false,
  });
  if (admit)
    vi.spyOn(f.podRepo.retainedCheckpoints!, 'latest').mockReturnValue({
      binding: { continuation: { prepareOnly: true } },
      checked: { result: createPassingValidationResult('prepare') },
    } as never);
  f.provider.getPrStatus.mockResolvedValue(validStatus());
  const polling = vi.fn();
  const captured = {
    ...f.mainCaptured,
    prManagerFactory: () => f.provider,
    startMergePolling: polling,
    transition: vi.fn(f.mainCaptured.transition),
  };
  const workflow = createApprovalWorkflow({
    ...captured,
    ...createApprovalDeliveryPreparation(captured),
    ...createApprovalDeliveryExecution(captured),
  });
  const options = {
    publishOnly: true,
    actor: { type: 'human' as const, userId: 'operator' },
    reason: 'Approve this checked source for PR publication only, not merge',
  };
  return { ...f, captured, polling, workflow, options };
}

function noMergeOrCleanup(f: ReturnType<typeof fixture>) {
  expect(f.pod().status).toBe('validated');
  expect(f.provider.mergePr).not.toHaveBeenCalled();
  expect(f.polling).not.toHaveBeenCalled();
  expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  expect(f.mainCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM merge_intents').get()).toEqual({ n: 0 });
}

describe('human PR-only publication', () => {
  it.each([
    true,
    false,
  ])('publishes only, with no transient merging state (existing PR: %s)', async (existingPr) => {
    const f = fixture(existingPr);
    const transition = f.captured.transition;
    const original = f.pod();
    f.provider.getPrStatus.mockResolvedValue(
      validStatus({ mergeBlocked: true, reviewDecision: 'REVIEW_REQUIRED' }),
    );
    await f.workflow.approveSession('prepare', f.options);
    expect(f.pod().prUrl).toBe('https://github.com/org/repo/pull/27');
    expect(f.pod().containerId).toBe(original.containerId);
    expect(f.pod().worktreePath).toBe(original.worktreePath);
    expect(f.pod().validationAttempts).toBe(original.validationAttempts);
    expect(f.pod().lifecycleGeneration).toBe(original.lifecycleGeneration);
    expect(f.provider.createPr).toHaveBeenCalledTimes(existingPr ? 0 : 1);
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledOnce();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    noMergeOrCleanup(f);
  });
  it.each([
    'target',
    'head',
  ] as const)('refuses mismatched PR %s without merging or cleanup', async (kind) => {
    const f = fixture();
    f.provider.getPrStatus.mockResolvedValue(
      kind === 'target'
        ? validStatus({
            sourceTarget: {
              repository: 'https://github.com/org/repo',
              branch: 'another',
              baseBranch: 'main',
            },
          })
        : validStatus({ headSha: 'f'.repeat(40) }),
    );
    await expect(f.workflow.approveSession('prepare', f.options)).rejects.toMatchObject({
      code: 'DELIVERY_RECONCILIATION_REQUIRED',
    });
    if (kind === 'target') expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    noMergeOrCleanup(f);
  });
  it('leaves a stalled source publication validated, not resumable as a merge', async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const push = vi.mocked(f.worktreeManager.pushBranch).getMockImplementation()!;
    vi.mocked(f.worktreeManager.pushBranch).mockImplementationOnce(async (...args) => {
      await pending;
      return push(...args);
    });
    const publication = f.workflow.approveSession('prepare', f.options);
    try {
      await vi.waitFor(() => expect(f.worktreeManager.pushBranch).toHaveBeenCalledOnce());
      noMergeOrCleanup(f);
      await expect(f.workflow.approveSession('prepare', f.options)).rejects.toMatchObject({
        code: 'APPROVAL_IN_PROGRESS',
      });
    } finally {
      release();
    }
    await publication;
    noMergeOrCleanup(f);
  });
  it('retains source and counters on failed publication without admitting a merge', async () => {
    const f = fixture();
    const original = f.pod();
    vi.mocked(f.worktreeManager.pushBranch).mockRejectedValueOnce(
      new Error('Native publication response unavailable'),
    );
    await expect(f.workflow.approveSession('prepare', f.options)).rejects.toThrow(
      'delivery failed',
    );
    expect(f.pod().containerId).toBe(original.containerId);
    expect(f.pod().validationAttempts).toBe(original.validationAttempts);
    noMergeOrCleanup(f);
  });
  it.each([
    'automation',
    'unchecked',
    'reason',
  ] as const)('refuses %s before provider/source mutation', async (kind) => {
    const f = fixture(true, kind !== 'unchecked');
    const options = {
      ...f.options,
      ...(kind === 'automation'
        ? { actor: { type: 'automation' as const, id: 'unattended' } }
        : {}),
      ...(kind === 'reason' ? { reason: '' } : {}),
    };
    await expect(f.workflow.approveSession('prepare', options)).rejects.toMatchObject({
      code: 'PR_PUBLICATION_APPROVAL_REQUIRED',
    });
    expect(f.provider.getPrStatus).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    noMergeOrCleanup(f);
  });
  it('does not complete no-change source or trigger dependents as a substitute for publication', async () => {
    const f = fixture(false);
    vi.mocked(f.worktreeManager.getDiffStats).mockResolvedValue({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    vi.mocked(f.worktreeManager.hasChangesAgainstBase!).mockResolvedValue(false);
    await expect(f.workflow.approveSession('prepare', f.options)).rejects.toMatchObject({
      code: 'PR_PUBLICATION_NO_CHANGES',
    });
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    noMergeOrCleanup(f);
  });
});

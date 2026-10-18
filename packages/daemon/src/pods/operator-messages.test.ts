import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createNudgeRepository } from './nudge-repository.js';
describe('complete operator message lifetime', () => {
  it('persists actor-labelled attached reply and queued guidance before resolving the shared waiter, through SQLite reopen', async () => {
    const f = createOperatorFixture(true);
    const request = f.awaiting();
    const owner = f.messages();
    const waiter = f.waiter();
    const actor = { type: 'human' as const, userId: 'reviewer', displayName: 'Reviewer' };
    const profile = f.profiles.get('test-profile');
    await owner.sendMessage.call(f.calls, 'prepare', 'Recorded answer', actor);
    await expect(waiter.wait).resolves.toBe('Recorded answer');
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.deps.escalationRepo.getOrThrow(request.id).response).toMatchObject({
      actor,
      response: 'Recorded answer',
    });
    expect(f.deps.nudgeRepo.listPending('prepare')[0]?.message).toBe('Recorded answer');
    const saved = f.pod();
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(createEscalationRepository(f.db).getOrThrow(request.id).response).toMatchObject({
      actor,
      response: 'Recorded answer',
    });
    expect(createNudgeRepository(f.db).listPending('prepare')[0]?.message).toBe('Recorded answer');
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('queues detached fallback and resumes with the same text after resolving the old tool promise', async () => {
    const f = createOperatorFixture();
    f.awaiting();
    const waiter = f.waiter(true);
    await f.messages().sendMessage.call(f.calls, 'prepare', 'Detached answer');
    await expect(waiter.wait).resolves.toBe('Detached answer');
    const queued = f.deps.nudgeRepo.listPending('prepare')[0]?.message;
    expect(queued).toContain('Fallback response for the previous ask_human MCP call');
    expect(f.ctx.runtime.resume).toHaveBeenCalledWith('prepare', queued, 'container-123', {});
    expect(f.calls.handleCompletion).toHaveBeenCalledWith('prepare');
  });
  it('retains a durable unresolved run and queues the reply without another runtime conversation', async () => {
    const f = createOperatorFixture();
    const ledger = f.podRepo.taskExecutions;
    if (!ledger) throw new Error('Missing task ledger');
    const pod = f.pod();
    const run = ledger.beginRun('prepare', pod.lifecycleGeneration, pod.finalization?.cycle ?? 0, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: 'account',
    });
    f.awaiting();
    await f.messages().sendMessage.call(f.calls, 'prepare', 'Wait for current run');
    expect(f.deps.nudgeRepo.listPending('prepare')[0]?.message).toBe('Wait for current run');
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    ledger.finishRun(run, 'stopped', null);
  });
  it('enforces the budget extension cap and delegates completion after an accepted extension', async () => {
    const f = createOperatorFixture();
    f.podRepo.update('prepare', {
      status: 'paused',
      pauseReason: 'budget',
      budgetExtensionsUsed: 1,
    });
    f.messagesCaptured.executionForPod = () => ({
      ...f.passContext().profile,
      maxBudgetExtensions: 1,
    });
    await expect(
      f.messages().sendMessage.call(f.calls, 'prepare', 'continue'),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    f.podRepo.update('prepare', { budgetExtensionsUsed: 0 });
    await f.messages().sendMessage.call(f.calls, 'prepare', 'continue');
    expect(f.pod()).toMatchObject({
      status: 'running',
      pauseReason: null,
      budgetExtensionsUsed: 1,
    });
    expect(f.calls.handleCompletion).toHaveBeenCalledWith('prepare');
  });
  it('repairs host-fetch auth by queueing without container injection or agent resume', async () => {
    const f = createOperatorFixture();
    f.awaiting('request_credential', {
      service: 'github',
      reason: 'Host fetch',
      source: 'host_fetch',
    });
    await f.messages().sendMessage.call(f.calls, 'prepare', 'repaired');
    expect(f.pod()).toMatchObject({ status: 'queued', pendingEscalation: null });
    expect(f.messagesCaptured.enqueueSession).toHaveBeenCalledWith('prepare');
    expect(f.cm.writeFile).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('retries a carried PR push with zero deletions and resolves deferred auto-approval dynamically', async () => {
    vi.useFakeTimers();
    const f = createOperatorFixture();
    f.awaiting('request_credential', {
      service: 'github',
      reason: 'Host push',
      source: 'host_push',
    });
    f.podRepo.update('prepare', {
      prUrl: 'https://github.com/org/repo/pull/29',
      autoApprove: true,
    });
    await f.messages().sendMessage.call(f.calls, 'prepare', 'repaired');
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: 'branch',
        maxDeletions: 0,
        pat: 'synthetic-git-key',
      }),
    );
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('validated');
    const approve = vi.fn(async () => {});
    f.calls.approveSession = approve;
    await vi.advanceTimersByTimeAsync(0);
    expect(approve).toHaveBeenCalledWith('prepare', { automation: true });
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
  });
  it('re-parks credential-class push failure with retained resources', async () => {
    const f = createOperatorFixture();
    f.awaiting('request_credential', {
      service: 'github',
      reason: 'Host push',
      source: 'host_push',
    });
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(
      new GitCredentialError('Synthetic rejection', 'github', 'push', 'synthetic'),
    );
    await f.messages().sendMessage.call(f.calls, 'prepare', 'repaired');
    expect(f.pod()).toMatchObject({
      status: 'awaiting_input',
      containerId: 'container-123',
      worktreePath: f.directory,
    });
    expect(f.pod().pendingEscalation?.payload).toMatchObject({ source: 'host_push' });
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });
  it('saves daemon delivery guidance for direct source requests without vending credentials', async () => {
    const f = createOperatorFixture();
    f.awaiting('request_credential', {
      service: 'ado',
      reason: 'Agent source auth',
      source: 'agent',
    });
    await f.messages().sendMessage.call(f.calls, 'prepare', 'answer');
    expect(f.deps.nudgeRepo.listPending('prepare')[0]?.message).toContain(
      'Source credentials stay with the AutoPod daemon',
    );
    expect(f.cm.writeFile).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('routes dismissals to validation without starting another agent turn', async () => {
    const f = createOperatorFixture();
    f.awaiting('validation_override', { findings: [], attempt: 1, maxAttempts: 3 });
    await f.messages().sendMessage.call(f.calls, 'prepare', 'dismiss all');
    expect(f.calls.triggerValidation).toHaveBeenCalledWith('prepare');
    expect(f.messagesCaptured.taskFeedbackEvents).not.toHaveBeenCalled();
    expect(f.pod().pendingEscalation).toBeNull();
  });
  it('reads the live Goal projection and refuses ordinary conversation restart', async () => {
    const f = createOperatorFixture();
    f.awaiting();
    const owner = f.messages();
    await f.goal();
    await expect(owner.sendMessage.call(f.calls, 'prepare', 'resume')).rejects.toMatchObject({
      code: 'GOAL_NATIVE_RESUME_REQUIRED',
    });
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
});

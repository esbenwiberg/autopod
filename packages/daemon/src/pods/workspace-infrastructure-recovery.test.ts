import { describe, expect, it, vi } from 'vitest';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { createWorkspaceFixture, deferred } from '../test-utils/workspace-recovery-helpers.js';
import { sandboxStartupRetryInput } from './sandbox-startup-admission.js';
const error = () => new SandboxInfrastructureError(403, { requestId: 'synthetic' });
function fresh(f: ReturnType<typeof createWorkspaceFixture>) {
  f.sandbox();
  f.podRepo.update('prepare', {
    lastValidationResult: null,
    taskSummary: null,
    prUrl: null,
    claudeSessionId: null,
    codexSessionId: null,
    piSessionId: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  return f.pod();
}
describe('workspace infrastructure recovery lifetime', () => {
  it('uses actual retry admission, confirms cleanup and requeues through the live queue-safe port', async () => {
    const f = createWorkspaceFixture();
    const pod = fresh(f);
    const owner = f.infrastructure();
    const requeue = vi.fn();
    f.live.requeueSessionAfterCurrent = requeue;
    const ledger = f.podRepo.sandboxStartupRetries;
    if (!ledger) throw new Error('Missing startup ledger');
    const admit = vi.spyOn(ledger, 'assertCanAdmit');
    f.live.sandboxInfrastructureRetryBackoffMs = [10, 20];
    await expect(
      owner.tryRecoverTransientSandboxFailure('prepare', pod, false, error(), 'setup'),
    ).resolves.toBe(true);
    expect(admit).toHaveBeenCalledWith(
      'prepare',
      pod.lifecycleGeneration,
      expect.any(Object),
      expect.any(String),
      [10, 20],
    );
    expect(f.cm.kill).toHaveBeenCalledWith('container-123');
    expect(requeue).toHaveBeenCalledWith('prepare');
    expect(f.pod()).toMatchObject({
      status: 'queued',
      containerId: null,
      recoveryWorktreePath: f.directory,
      infrastructureRecoveryCount: 1,
      infrastructureFailure: { recoveryDisposition: 'automatic_retry_scheduled' },
    });
  });
  it('blocks ambiguous durable execution but retains original skip-agent validation-only recovery', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    const original = f.pod();
    await expect(
      f
        .infrastructure()
        .tryRecoverTransientSandboxFailure('prepare', original, false, error(), 'agent'),
    ).resolves.toBe(false);
    expect(f.pod().infrastructureFailure).toMatchObject({
      recoveryDisposition: 'agent_execution_ambiguous',
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
    f.podRepo.update('prepare', { skipAgent: true });
    f.live.requeueSessionAfterCurrent = vi.fn();
    await expect(
      f
        .infrastructure()
        .tryRecoverTransientSandboxFailure('prepare', f.pod(), true, error(), 'setup'),
    ).resolves.toBe(true);
    expect(f.pod().skipAgent).toBe(true);
  });
  it('honors exhausted persisted startup allowance without deleting the container', async () => {
    const f = createWorkspaceFixture();
    fresh(f);
    f.podRepo.update('prepare', { infrastructureRecoveryCount: 1 });
    const ledger = f.podRepo.sandboxStartupRetries;
    if (!ledger) throw new Error('Missing startup ledger');
    const input = sandboxStartupRetryInput(f.pod());
    const first = ledger.admit(
      'prepare',
      f.pod().lifecycleGeneration,
      input.identity,
      input.bindingHash,
      [30000],
    );
    ledger.start(first.id);
    ledger.finish(first.id, 'transient', 1);
    await expect(
      f
        .infrastructure()
        .tryRecoverTransientSandboxFailure('prepare', f.pod(), false, error(), 'setup'),
    ).resolves.toBe(false);
    expect(f.pod().infrastructureFailure).toMatchObject({
      recoveryDisposition: 'automatic_retry_exhausted',
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('retains an unconfirmed sandbox and refuses stale post-kill cleanup effects', async () => {
    const f = createWorkspaceFixture();
    const pod = fresh(f);
    vi.mocked(f.cm.kill).mockRejectedValueOnce(new Error('Synthetic delete unavailable'));
    await expect(
      f.infrastructure().tryRecoverTransientSandboxFailure('prepare', pod, false, error(), 'setup'),
    ).resolves.toBe(false);
    expect(f.pod()).toMatchObject({
      containerId: 'container-123',
      infrastructureFailure: { recoveryDisposition: 'sandbox_cleanup_unconfirmed' },
    });
    const current = f.pod();
    const gate = deferred();
    vi.mocked(f.cm.kill).mockReturnValueOnce(gate.promise);
    const pending = f
      .infrastructure()
      .tryRecoverTransientSandboxFailure('prepare', current, false, error(), 'setup');
    await vi.waitFor(() => expect(f.cm.kill).toHaveBeenCalledTimes(2));
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { containerId: 'replacement' });
    gate.resolve();
    await expect(pending).resolves.toBe(true);
    expect(f.pod().containerId).toBe('replacement');
    expect(f.common.killSidecarsForPod).not.toHaveBeenCalled();
  });
  it('reads provider attempt evidence live and uses the deferred compatibility enqueue fallback', async () => {
    const f = createWorkspaceFixture();
    const pod = fresh(f);
    const owner = f.infrastructure();
    expect(owner.hasDurableAgentExecutionEvidence(pod)).toBe(false);
    f.nativeAttempts.ensureProviderAttempt(pod, f.passContext().profile);
    f.repo.close('prepare', {
      nativeSessionId: 'observed-session',
      outcome: 'aborted',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(owner.hasDurableAgentExecutionEvidence(pod)).toBe(true);
    f.live.providerAttemptRepo = undefined;
    await expect(
      owner.tryRecoverTransientSandboxFailure('prepare', pod, false, error(), 'setup'),
    ).resolves.toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.live.enqueueSession).toHaveBeenCalledWith('prepare');
  });
});

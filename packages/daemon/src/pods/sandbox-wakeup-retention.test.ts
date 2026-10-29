import { describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { retainTestWakeup } from '../test-utils/sandbox-wakeup-helpers.js';
import { createResourceCleanup } from './resource-cleanup.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';
import { SandboxTerminalReaper } from './sandbox-terminal-reaper.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';

function fixture() {
  const f = createOperatorFixture(true, 'sandbox');
  retainTestWakeup(f.podRepo, 'container-123');
  return f;
}
describe('outcome-unknown wakeup resource custody', () => {
  it('Kill refuses before stopping preview, deleting worktrees or changing lifecycle', async () => {
    const f = fixture();
    const before = f.pod();
    await expect(f.kill().killSession('prepare')).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
    });
    expect(f.killCaptured.stopSandboxPreviewProxy).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
    expect(f.pod()).toEqual(before);
  });
  it('central cleanup refuses both deletion and suspension before side effects', async () => {
    const f = fixture();
    const proxy = vi.fn(async () => {});
    const cleanup = createResourceCleanup(
      {},
      {
        podRepo: f.podRepo,
        logger: f.deps.logger,
        ownsLifecycle: () => true,
        stopSandboxPreviewProxy: proxy,
        stopHaproxyDenyReceiver: proxy,
        containerManagerFactory: f.deps.containerManagerFactory,
        forgetMaxCredentialLineage: vi.fn(),
      },
    );
    for (const mode of ['kill', 'stop'] as const)
      await expect(cleanup.cleanupContainer(f.pod(), 'test', mode)).rejects.toMatchObject({
        code: 'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
      });
    expect(proxy).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('Delete refuses before cleanup even if no worker execution is active', async () => {
    const f = fixture();
    f.mainCaptured.transition(f.pod(), 'failed');
    const cleanup = vi.fn(async () => {});
    const deletion = createWorkspaceDeletion({
      podRepo: f.podRepo,
      executionForPod: f.captured.resolveEffectiveBoundProfile,
      clearPreviewTimer: vi.fn(),
      stopSandboxPreviewProxy: cleanup,
      killSidecarsForPod: cleanup,
      containerManagerFactory: f.deps.containerManagerFactory,
      destroyPodNetwork: cleanup,
      cleanupTestRunBranches: cleanup,
      worktreeManager: f.worktreeManager,
      pendingUpdateFromBaseIntents: new Set(),
      forceWithLeaseAllowances: new Set(),
      logger: f.deps.logger,
    });
    await expect(deletion.deleteSession('prepare')).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  });
  it('a current pointer cleared after dispatch cannot orphan the original restore', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { containerId: null });
    const next = f.reopen();
    expect(next.pods.listReferencedContainerIds()).toContain('container-123');
    expect(() => next.pods.delete('prepare')).toThrow('unresolved wakeup');
    expect(next.pods.getOrThrow('prepare').worktreePath).not.toBeNull();
    const kill = vi.fn(async () => {});
    await new SandboxOrphanReaper({
      podRepo: next.pods,
      sandboxContainerManager: {
        kill,
        listSandboxes: vi.fn(async () => [
          {
            id: 'container-123',
            labels: { managedBy: 'autopod' },
            createdAt: '2020-01-01T00:00:00Z',
          },
        ]),
      } as unknown as SandboxContainerManager,
      logger: f.deps.logger,
    }).runSweep();
    expect(kill).not.toHaveBeenCalled();
  });
  it('a terminal row cannot authorize deleting an unresolved restore', async () => {
    const f = fixture();
    for (const status of ['validating', 'validated', 'approved', 'merging', 'complete'] as const)
      f.mainCaptured.transition(f.pod(), status);
    await new SandboxTerminalReaper({
      podRepo: f.podRepo,
      sandboxContainerManager: f.cm as unknown as SandboxContainerManager,
      logger: f.deps.logger,
    }).runSweep();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
  });
});

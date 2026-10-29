import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createExternalDeliveryFixture } from '../test-utils/external-delivery-helpers.js';
import { createResourceCleanup } from './resource-cleanup.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';
import { SandboxTerminalReaper } from './sandbox-terminal-reaper.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';

const fixtures: ReturnType<typeof createExternalDeliveryFixture>[] = [];
async function fixture() {
  const f = createExternalDeliveryFixture(true);
  fixtures.push(f);
  await f.approve();
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

describe('durable report-retention fences after externally verified delivery', () => {
  it('central cleanup cannot delete a retained sandbox, including from a different pod identity', async () => {
    const f = await fixture();
    const cleanup = createResourceCleanup(
      {},
      {
        podRepo: f.podRepo,
        logger: f.deps.logger,
        ownsLifecycle: () => true,
        stopSandboxPreviewProxy: vi.fn(async () => {}),
        stopHaproxyDenyReceiver: vi.fn(async () => {}),
        containerManagerFactory: f.deps.containerManagerFactory,
        forgetMaxCredentialLineage: vi.fn(),
      },
    );
    await expect(cleanup.cleanupContainer(f.pod(), 'operator')).rejects.toMatchObject({
      code: 'DELIVERY_REPORTS_PENDING',
    });
    await expect(
      cleanup.cleanupContainer({ ...f.pod(), id: 'different-owner' }, 'stale'),
    ).rejects.toMatchObject({ code: 'DELIVERY_REPORTS_PENDING' });
    expect(f.cm.kill).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(next.pods.externalDeliveries?.retains('container-123')).toBe(true);
    expect(next.pods.externalDeliveries?.get('prepare')?.reports).toBe('pending');
  });
  it('terminal reaper retains a completed sandbox rather than assuming its reports were collected', async () => {
    const f = await fixture();
    await new SandboxTerminalReaper({
      podRepo: f.podRepo,
      sandboxContainerManager: f.cm as unknown as SandboxContainerManager,
      logger: f.deps.logger,
    }).runSweep();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
  });
  it('orphan reaper still retains the original sandbox if the live pod binding is later lost', async () => {
    const f = await fixture();
    f.podRepo.update('prepare', { containerId: null });
    const kill = vi.fn(async () => {});
    const manager = {
      kill,
      listSandboxes: vi.fn(async () => [
        {
          id: 'container-123',
          labels: { managedBy: 'autopod' },
          createdAt: '2020-01-01T00:00:00Z',
        },
      ]),
    } as unknown as SandboxContainerManager;
    await new SandboxOrphanReaper({
      podRepo: f.podRepo,
      sandboxContainerManager: manager,
      logger: f.deps.logger,
    }).runSweep();
    expect(kill).not.toHaveBeenCalled();
  });
  it('explicit Delete refuses before sidecars, worktree, network or container cleanup', async () => {
    const f = await fixture();
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
      code: 'DELIVERY_REPORTS_PENDING',
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
    expect(() => f.podRepo.delete('prepare')).toThrow('reports remain pending');
  });
});

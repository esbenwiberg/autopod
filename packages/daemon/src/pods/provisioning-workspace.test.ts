import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
function fixture() {
  const f = createProvisioningFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('provisioning workspace', () => {
  it('materializes an authenticated workspace and records its immutable starting commit before spawn', async () => {
    const f = fixture();
    const result = await f.workspace();
    if (result.kind !== 'ready') throw new Error('Unexpected halt');
    expect(result.worktreePath).toBe('/tmp/worktree/abc');
    expect(result.pod.startCommitSha).toBeTruthy();
    expect(f.worktreeManager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'prepare',
        pat: 'synthetic-git-key',
      }),
    );
    expect(f.pod().status).toBe('provisioning');
    expect(f.pod().profileSnapshot).toEqual(f.profiles.get('test-profile'));
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('propagates worktree errors before provisioning or container creation', async () => {
    const f = fixture();
    const failure = new Error('Clone failed');
    vi.mocked(f.worktreeManager.create).mockRejectedValueOnce(failure);
    await expect(f.workspace()).rejects.toBe(failure);
    expect(f.pod().status).toBe('queued');
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('keeps the caller startup admission visible when a subsequent transition throws', async () => {
    const f = fixture();
    f.profiles.update('test-profile', {
      executionTarget: 'sandbox',
      warmImageTag: 'example.azurecr.io/test:latest',
    });
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    const failure = new Error('Transition failed');
    vi.mocked(f.captured.transition).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(f.workspace()).rejects.toBe(failure);
    expect(f.run.startupAdmission).toMatchObject({
      id: expect.any(String),
      started: expect.any(Number),
    });
    expect(f.podRepo.sandboxStartupRetries?.state('prepare')).toMatchObject({ executedCount: 1 });
    f.run.finishStartup('nonretryable');
    expect(f.run.startupAdmission).toBeUndefined();
    expect(f.podRepo.sandboxStartupRetries?.state('prepare').latest?.outcome).toBe('nonretryable');
  });
  it('reads the launch capability checker at invocation and rejects before workspace effects', async () => {
    const f = fixture();
    const config = { version: 1 };
    const failure = new Error('Capability revoked');
    const assertCurrentCapabilities = vi.fn(async () => {
      throw failure;
    });
    const owner = (await import('./provisioning-workspace.js')).createProvisioningWorkspace(
      {
        get launchConfiguration() {
          return { assertCurrentCapabilities };
        },
      } as unknown as Parameters<
        typeof import('./provisioning-workspace.js').createProvisioningWorkspace
      >[0],
      f.captured,
    );
    await expect(
      owner.prepareWorkspace({
        ...f.input(),
        launchConfig: config as unknown as NonNullable<ReturnType<typeof f.input>['launchConfig']>,
      }),
    ).rejects.toBe(failure);
    expect(assertCurrentCapabilities).toHaveBeenCalledExactlyOnceWith(config);
    expect(f.worktreeManager.create).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
});

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

describe('provisioning container', () => {
  it('mounts private runtime state and preserves preview ports without agent credentials in spawn env', async () => {
    const f = fixture();
    const result = await f.container();
    expect(result.containerManager).toBe(f.cm);
    const config = vi.mocked(f.cm.spawn).mock.calls[0]?.[0];
    expect(config).toMatchObject({
      podId: 'prepare',
      ports: [{ container: 3000, host: 32123 }],
      env: { POD_ID: 'prepare', PREVIEW_URL: 'http://127.0.0.1:32123' },
    });
    expect(config?.volumes).toContainEqual(
      expect.objectContaining({ host: `${f.directory}/claude/prepare` }),
    );
    expect(config?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  for (const phase of ['health', 'main'] as const) {
    it(`kills the started sidecar exactly once when ${phase} provisioning fails`, async () => {
      const f = fixture();
      f.profiles.update('test-profile', {
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'test',
          },
        },
        networkPolicy: { enabled: true, mode: 'allow-all', allowedHosts: [] },
      });
      f.podRepo.update('prepare', { requireSidecars: ['dagger'] });
      f.captured.networkManager = {
        getGatewayIp: vi.fn(async () => '172.18.0.1'),
        buildNetworkConfig: vi.fn(async () => ({
          networkName: 'private-network',
          firewallScript: 'firewall',
        })),
      };
      const sidecars = {
        spawn: vi.fn(async () => ({ containerId: 'sidecar', name: 'dagger' })),
        waitHealthy: vi.fn(async () => {}),
        kill: vi.fn(async () => {}),
        getBridgeIp: vi.fn(async () => '172.18.0.2'),
        reconcileOrphans: vi.fn(async () => 0),
      };
      f.captured.sidecarManager = sidecars;
      const failure = new Error(`${phase} failed`);
      if (phase === 'health') sidecars.waitHealthy.mockRejectedValueOnce(failure);
      else vi.mocked(f.cm.spawn).mockRejectedValueOnce(failure);
      await expect(f.container()).rejects.toBe(failure);
      expect(sidecars.kill).toHaveBeenCalledExactlyOnceWith('sidecar');
      expect(sidecars.spawn.mock.invocationCallOrder[0]).toBeLessThan(
        sidecars.waitHealthy.mock.invocationCallOrder[0] ?? 0,
      );
      if (phase === 'health') expect(f.cm.spawn).not.toHaveBeenCalled();
      else {
        expect(f.cm.spawn).toHaveBeenCalledWith(
          expect.objectContaining({ networkName: 'private-network' }),
        );
        expect(sidecars.getBridgeIp.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(f.cm.spawn).mock.invocationCallOrder[0] ?? 0,
        );
      }
    });
  }
  it('cleans the authenticated reference worktree on archive failure and retains its outer-finally archive path', async () => {
    const f = fixture();
    const workspace = await f.workspace();
    if (workspace.kind !== 'ready') throw new Error('Unexpected halt');
    const failure = new Error('Archive failed');
    const archive = vi.spyOn(f.captured, 'execFileAsync').mockRejectedValueOnce(failure);
    const githubAuth = {
      resolveCredential: vi.fn(async () => ({
        token: 'synthetic-reference-key',
        username: 'test',
      })),
      getStatus: vi.fn(async () => ({ available: true as const, login: 'test', setup: 'test' })),
    };
    const owner = (await import('./provisioning-container.js')).createProvisioningContainer(
      { ...f.deps, githubAuth },
      f.captured,
    );
    await expect(
      owner.prepareContainer({
        ...workspace,
        pod: {
          ...workspace.pod,
          referenceRepos: [
            {
              url: 'https://github.com/test/reference',
              mountPath: 'reference',
              sourceProfile: 'test-profile',
            },
          ],
        },
      }),
    ).rejects.toBe(failure);
    expect(githubAuth.resolveCredential).toHaveBeenCalledOnce();
    expect(f.worktreeManager.cleanup).toHaveBeenCalledExactlyOnceWith('/tmp/worktree/abc');
    expect(f.run.stagedReferenceArchivePaths.size).toBe(1);
    expect(archive).toHaveBeenCalledWith(
      'tar',
      expect.arrayContaining(['--exclude=.git', '-czf']),
      { timeout: 60_000 },
    );
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
});

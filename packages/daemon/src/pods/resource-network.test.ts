import { describe, expect, it } from 'vitest';
import { createResourceFixture } from '../test-utils/resource-helpers.js';
describe('resource network controls', () => {
  it('reads immutable launch refusal live before legacy mutation', async () => {
    const f = createResourceFixture();
    const owner = f.networkOwner();
    f.live.launchConfiguration = {};
    await expect(owner.refreshNetworkPolicy('test-profile')).rejects.toMatchObject({
      code: 'CONFIG_API_VERSION_UNSUPPORTED',
      statusCode: 410,
    });
    expect(f.network.buildNetworkConfig).not.toHaveBeenCalled();
  });
  it('tears down best effort or rethrows strict identity', async () => {
    const f = createResourceFixture();
    const error = new Error('Synthetic bridge');
    f.network.destroyNetworkForPod.mockRejectedValue(error);
    await f.networkOwner().destroyPodNetwork('prepare');
    await expect(f.networkOwner().destroyPodNetwork('prepare', true)).rejects.toBe(error);
  });
  it('builds local policy per pod with sidecar IP and exact daemon host/port', async () => {
    const f = createResourceFixture();
    f.profiles.update('test-profile', {
      networkPolicy: { enabled: true, mode: 'restricted', allowedHosts: ['service.invalid'] },
    });
    f.podRepo.update('prepare', { sidecarContainerIds: { db: 'sidecar' } });
    await f.networkOwner().refreshNetworkPolicy('test-profile');
    expect(f.sidecars.getBridgeIp).toHaveBeenCalledWith(
      { containerId: 'sidecar', name: 'db' },
      'autopod-prepare',
    );
    expect(f.network.buildNetworkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      expect.any(Array),
      '172.22.0.1',
      expect.anything(),
      'prepare',
      ['172.22.0.4'],
      ['daemon.internal'],
      3210,
    );
    expect(f.cm.refreshFirewall).toHaveBeenCalledWith('container-123', 'synthetic firewall');
  });
  it('uses sandbox payload and isolates a failed local refresh from another pod', async () => {
    const f = createResourceFixture();
    f.profiles.update('test-profile', {
      networkPolicy: { enabled: true, mode: 'restricted', allowedHosts: ['service.invalid'] },
    });
    f.insertFix('running');
    f.sandbox();
    f.network.getGatewayIp.mockRejectedValueOnce(new Error('Synthetic gateway'));
    await f.networkOwner().refreshNetworkPolicy('test-profile');
    expect(f.cm.refreshFirewall).toHaveBeenCalledWith('container-123', expect.any(String));
    expect(f.network.getGatewayIp).toHaveBeenCalledWith('fix-child');
    expect(f.deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'fix-child' }),
      'Failed to refresh network policy on running container',
    );
  });
  it('skips disabled profiles or an empty eligible set', async () => {
    const f = createResourceFixture();
    await f.networkOwner().refreshNetworkPolicy('test-profile');
    expect(f.cm.refreshFirewall).not.toHaveBeenCalled();
    f.profiles.update('test-profile', {
      networkPolicy: { enabled: true, mode: 'restricted', allowedHosts: [] },
    });
    f.podRepo.update('prepare', { status: 'paused' });
    await f.networkOwner().refreshNetworkPolicy('test-profile');
    expect(f.network.buildNetworkConfig).not.toHaveBeenCalled();
  });
});

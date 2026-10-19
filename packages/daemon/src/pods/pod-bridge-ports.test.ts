import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import type { SessionBridgeManagerPort } from './pod-bridge-ports.js';
describe('narrow bridge manager contract', () => {
  it('retains the actual manager receiver for a live replaced revalidation property', async () => {
    const f = createAdmissionFixture();
    const manager = f.manager();
    const port: SessionBridgeManagerPort = manager;
    const bridge = createSessionBridge({
      ...f.deps,
      podManager: port,
      pendingRequestsByPod: new Map(),
    });
    const revalidate = vi.fn<SessionBridgeManagerPort['revalidateSession']>(function (
      this: unknown,
      id,
    ) {
      expect(this).toBe(manager);
      expect(id).toBe('prepare');
      return Promise.resolve({ newCommits: true, result: 'pass' });
    });
    manager.revalidateSession = revalidate;
    await expect(bridge.revalidateLinkedPod('prepare')).resolves.toEqual({
      newCommits: true,
      result: 'pass',
    });
    expect(revalidate).toHaveBeenCalledOnce();
  });
  it('projects stored preview and keeps heartbeat/configuration access behind the same original port', () => {
    const f = createAdmissionFixture();
    const manager = f.manager();
    const beat = vi.spyOn(manager, 'touchHeartbeat');
    const bridge = createSessionBridge({
      ...f.deps,
      podManager: manager,
      pendingRequestsByPod: new Map(),
    });
    f.podRepo.update('prepare', { previewUrl: 'http://local.invalid:3210' });
    expect(bridge.getPreviewUrl('prepare')).toBe('http://local.invalid:3210');
    bridge.readOperatorGuidance('prepare');
    expect(beat).toHaveBeenCalledWith('prepare');
    expect(bridge.getMaxAiCalls('prepare')).toBe(
      f.profiles.get('test-profile').escalation?.askAi.maxCalls ?? 5,
    );
  });
});

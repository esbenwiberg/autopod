import { describe, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

describe('rejection network policy', () => {
  it('resumes an admitted Docker launch without refreshing any profile networks', async () => {
    const ctx = createTestContext();
    try {
      const { store, services } = createTestConfiguration(ctx.db);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const accounts = createProviderAccountStore(ctx.db);
      accounts.create({
        id: 'account',
        name: 'Fixture',
        provider: 'anthropic',
        credentials: { provider: 'anthropic', apiKey: 'fixture' },
      });
      services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
      ctx.deps.providerAccountStore = accounts;
      ctx.deps.launchConfiguration = {
        read: snapshots.get,
        executionSettings: (config) =>
          resolveLaunchExecutionSettings(config, { image: `sha256:${'a'.repeat(64)}` }),
        assertCurrentCapabilities: async () => {},
        prepareEnvironment: async () => 'fixture',
      };
      const manager = createPodManager(ctx.deps);
      const admitted = await admitLaunch({
        request: { repositoryId: 'repo-a', task: 'Repair feedback' },
        actorId: 'operator',
        services,
        snapshots,
        createPod: (config) => manager.createResolvedSession(config, 'operator').id,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = admitted.podId;
      ctx.podRepo.update(id, { status: 'validated', containerId: 'frozen-container' });
      const other = insertConfigurationTestPod(ctx.db, 'other-pod');
      ctx.podRepo.update(other, { status: 'running', containerId: 'other-container' });
      const otherBefore = ctx.podRepo.getOrThrow(other);
      const frozen = snapshots.get(id);
      const refresh = vi.spyOn(manager, 'refreshNetworkPolicy');
      vi.mocked(ctx.runtime.resume).mockImplementation(async function* () {
        yield {
          type: 'error',
          timestamp: new Date().toISOString(),
          message: 'Controlled stop',
          fatal: true,
        };
      });
      await manager.rejectSession(id, 'Fix the failing check');
      expect(ctx.runtime.resume).toHaveBeenCalled();
      expect(vi.mocked(ctx.runtime.resume).mock.calls[0]?.[1]).toContain('Fix the failing check');
      expect(refresh).not.toHaveBeenCalled();
      expect(ctx.containerManager.refreshFirewall).not.toHaveBeenCalled();
      expect(snapshots.get(id)).toEqual(frozen);
      expect(ctx.podRepo.getOrThrow(other)).toEqual(otherBefore);
      await expect(manager.refreshNetworkPolicy('test-profile')).rejects.toMatchObject({
        code: 'CONFIG_API_VERSION_UNSUPPORTED',
      });
    } finally {
      ctx.db.close();
    }
  });

  it('keeps validation evidence if retained continuation fails', async () => {
    const ctx = createTestContext();
    try {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Repair' },
        'operator',
      );
      const result = { ...createPassingValidationResult(pod.id), overall: 'fail' as const };
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        containerId: 'missing',
        lastValidationResult: result,
      });
      vi.mocked(ctx.containerManager.getStatus).mockResolvedValue('removed');
      await expect(manager.rejectSession(pod.id, 'Repair')).rejects.toThrow();
      expect(ctx.podRepo.getOrThrow(pod.id)).toMatchObject({
        status: 'failed',
        lastValidationResult: result,
      });
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });

  it('still refreshes the profile on legacy local hosts', async () => {
    const ctx = createTestContext();
    try {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Repair' },
        'operator',
      );
      ctx.podRepo.update(pod.id, { status: 'validated', containerId: 'legacy-container' });
      const refresh = vi.spyOn(manager, 'refreshNetworkPolicy');
      await manager.rejectSession(pod.id, 'Repair');
      expect(refresh).toHaveBeenCalledWith('test-profile');
      expect(ctx.runtime.resume).toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
});

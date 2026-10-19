import { describe, expect, it, vi } from 'vitest';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import { createAdmissionFixture, deferred } from '../test-utils/admission-queries-helpers.js';
import type { AdmissionMcpCalls } from './admission-contracts.js';
describe('admission read and capability projections', () => {
  it('projects stored filters/stats/series and validates existence before history fallback', () => {
    const f = createAdmissionFixture();
    f.insert('a', { seriesId: 's', status: 'failed' });
    const q = f.queries();
    expect(q.listSessions({ status: 'failed' }).map((p) => p.id)).toEqual(['a']);
    expect(q.getSession('a')).toEqual(f.podRepo.getOrThrow('a'));
    expect(q.getSeriesPods('s').map((p) => p.id)).toEqual(['a']);
    expect(q.getSessionStats()).toEqual(f.podRepo.getStats());
    expect(q.getValidationHistory('a')).toEqual([]);
    expect(() => q.getValidationHistory('missing')).toThrow();
    expect(q.getLaunchConfiguration('a')).toBeNull();
  });
  it('merges real legacy daemon/profile MCP values with profile precedence', () => {
    const f = createAdmissionFixture();
    f.deps.daemonConfig.mcpServers.push({ name: 'shared', url: 'https://daemon.invalid' });
    f.profiles.update('test-profile', {
      mcpServers: [
        { name: 'shared', url: 'https://profile.invalid', headers: { Authorization: 'synthetic' } },
      ],
    });
    expect(f.queries().getInjectedMcpServers('prepare')).toEqual([
      { name: 'shared', url: 'https://profile.invalid', headers: { Authorization: 'synthetic' } },
    ]);
  });
  it('resolves fallback MCP on the dynamic receiver after awaited native capability check', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    const saved = n.admit();
    await new Promise<void>((r) => setImmediate(r));
    f.podRepo.update(saved.podId, { status: 'running' });
    const gate = deferred();
    if (!f.live.launchConfiguration) throw new Error('Missing launch');
    f.live.launchConfiguration.assertCurrentCapabilities = vi.fn(() => gate.promise);
    const old = vi.fn<AdmissionMcpCalls['getInjectedMcpServers']>(() => []);
    const calls = { getInjectedMcpServers: old };
    const pending = f.queries().getInjectedMcpServer.call(calls, saved.podId, 'late');
    calls.getInjectedMcpServers = vi.fn(() => [{ name: 'late', url: 'https://late.invalid' }]);
    gate.resolve();
    await expect(pending).resolves.toEqual({ name: 'late', url: 'https://late.invalid' });
    expect(old).not.toHaveBeenCalled();
  });
  it('fences scoped HTTP vending with the live replacement capability checker and refuses nonrunning native access', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    const saved = n.admit();
    await new Promise<void>((r) => setImmediate(r));
    const calls = { getInjectedMcpServers: vi.fn(() => []) };
    await expect(
      f.queries().getInjectedMcpServer.call(calls, saved.podId, 'secret'),
    ).rejects.toMatchObject({ code: 'POD_NOT_RUNNING' });
    f.podRepo.update(saved.podId, { status: 'running' });
    const effects: string[] = [];
    const credentials: LaunchExecutionCredentials = {
      agent: async () => ({ buildEnv: {}, mcpServers: [] }),
      buildEnvironment: async () => ({}),
      deployment: async () => null,
      registries: async () => ({ files: [], nugetSecret: null }),
      httpServer: async () => {
        effects.push('vended');
        if (!f.live.launchConfiguration) throw new Error('Missing launch');
        f.live.launchConfiguration.assertCurrentCapabilities = async () => {
          effects.push('recheck');
          throw new Error('Synthetic revoked');
        };
        return {
          name: 'secret',
          url: 'https://scoped.invalid',
          headers: { Authorization: 'synthetic' },
        };
      },
    };
    if (!f.live.launchConfiguration) throw new Error('Missing launch');
    f.live.launchConfiguration.credentials = credentials;
    f.live.launchConfiguration.assertCurrentCapabilities = async () => {
      effects.push('check');
    };
    await expect(
      f.queries().getInjectedMcpServer.call(calls, saved.podId, 'secret'),
    ).rejects.toThrow('revoked');
    expect(effects).toEqual(['check', 'vended', 'recheck']);
    expect(calls.getInjectedMcpServers).not.toHaveBeenCalled();
  });
  it('checks native deployment capabilities before and after projected fallback and reads live launch', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    const saved = n.admit();
    await new Promise<void>((r) => setImmediate(r));
    const check = vi.fn(async () => {});
    if (!f.live.launchConfiguration) throw new Error('Missing launch');
    f.live.launchConfiguration.assertCurrentCapabilities = check;
    await expect(f.queries().getDeploymentConfiguration(saved.podId)).resolves.toBeNull();
    expect(check).toHaveBeenCalledTimes(2);
    expect(f.queries().getLaunchConfiguration(saved.podId)).toEqual(n.config);
  });
});

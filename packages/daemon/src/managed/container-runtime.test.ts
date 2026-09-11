import { readFileSync } from 'node:fs';
import type { ManagedPodRequest } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { ManagedContainerRuntime, type ReviewedContainerBoundary } from './container-runtime.js';

function fixture() {
  const request: ManagedPodRequest = JSON.parse(
    readFileSync(
      new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
      'utf8',
    ),
  ).ManagedPodRequest;
  const ensure = vi.fn(async (config: ContainerSpawnConfig) => {
    config.onCreated?.('container-one');
    return 'container-one';
  });
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const manager = {
    ensureManagedContainer: ensure,
    extractManagedOutput: vi.fn(),
    execInContainer: exec,
  } as unknown as ContainerManager;
  const config: ContainerSpawnConfig = {
    podId: 'pod-one',
    image: `fixture@sha256:${'a'.repeat(64)}`,
    env: {},
    exposeHostGateway: false,
    allowedHosts: [],
    networkPolicyMode: 'deny-all',
    firewallScript: 'fixture-deny-all',
    networkName: 'fixture-network',
    volumes: [
      { host: '/fixture/repo', container: '/repositories/fixture-repo', readOnly: true },
      { host: '/fixture/output', container: '/output', readOnly: false },
    ],
  };
  const binding: ReviewedContainerBoundary = {
    route: request.route,
    manager,
    image: config.image,
    command: ['fixture-agent', '--model', request.route.model],
    prepare: async () => config,
    quotaReady: async () => true,
    attachQuota: vi.fn(async () => {}),
  };
  const runtime = new ManagedContainerRuntime(
    [binding],
    () => ({ request, podId: 'pod-one', createdAt: 100 }),
    'fixture-supervisor',
  );
  return { request, config, runtime, ensure, exec, binding };
}
it('read-only/no-web mounts and exact routes reach the trusted guard with no worker credential', async () => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  expect(f.ensure).toHaveBeenCalledTimes(1);
  expect(f.ensure.mock.calls[0]?.[0].volumes?.[0]?.readOnly).toBe(true);
  expect(f.ensure.mock.calls[0]?.[0].networkPolicyMode).toBe('deny-all');
  expect(f.binding.attachQuota).toHaveBeenCalledTimes(1);
  expect(f.exec).toHaveBeenCalledTimes(4);
});
it('the objective cannot override reviewed model or runtime arguments', async () => {
  const f = fixture();
  f.request.task.objective = '--model=unreviewed-model';
  await f.runtime.ensure('pod-one', f.request, () => {});
  const launchCall = f.exec.mock.calls[2] as unknown as [string, string[]];
  const launch = JSON.parse(launchCall[1][4]!);
  expect(launch.argv.slice(-2)).toEqual(['--', '--model=unreviewed-model']);
  expect(launch.argv.slice(0, -2)).toEqual(f.binding.command);
});
it.each(['write', 'host', 'network', 'route', 'quota'] as const)(
  'rejects %s expansion before allocation',
  async (kind) => {
    const f = fixture();
    if (kind === 'write') {
      const volume = f.config.volumes?.[0];
      if (!volume) throw new Error('fixture-volume-required');
      volume.readOnly = false;
    }
    if (kind === 'host') f.config.volumes?.push({ host: '/', container: '/host' });
    if (kind === 'network') f.config.allowedHosts = ['other.test'];
    if (kind === 'route')
      f.request = { ...f.request, route: { ...f.request.route, model: 'other' } };
    if (kind === 'quota') f.binding.quotaReady = async () => false;
    await expect(f.runtime.ensure('pod-one', f.request, () => {})).rejects.toThrow();
    expect(f.ensure).not.toHaveBeenCalled();
  },
);

it('writable preparation excludes read-only mounts and occurs before worker attachment', async () => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  const call = f.exec.mock.calls[0] as unknown as [string, string[], unknown];
  expect(call[1].slice(3)).toEqual(['/output']);
  expect(call[2]).toEqual({ user: 'root' });
});
it('writable preparation failure prevents worker and channel startup', async () => {
  const f = fixture();
  f.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
  await expect(f.runtime.ensure('pod-one', f.request, () => {})).rejects.toThrow(
    'managed-writable-mount-unavailable',
  );
  expect(f.exec).toHaveBeenCalledTimes(1);
  expect(f.binding.attachQuota).not.toHaveBeenCalled();
});

it('verifies the reviewed image dependency cache before starting the worker', async () => {
  const f = fixture();
  f.binding.dependencyCache = {
    enrollmentId: 'fixture-repo',
    path: '/opt/autopod-managed/fixture/node_modules',
  };
  await f.runtime.ensure('pod-one', f.request, () => {});
  const cacheCall = f.exec.mock.calls[1] as unknown as [string, string[], unknown];
  expect(cacheCall[1].slice(-2)).toEqual([
    '/repositories/fixture-repo/node_modules',
    '/opt/autopod-managed/fixture/node_modules',
  ]);
  expect(cacheCall[2]).toEqual({ user: 'root' });
  expect(f.binding.attachQuota).toHaveBeenCalledTimes(1);
});

it('does not start a worker when the reviewed dependency cache is absent or mutable', async () => {
  const f = fixture();
  f.binding.dependencyCache = {
    enrollmentId: 'fixture-repo',
    path: '/opt/autopod-managed/fixture/node_modules',
  };
  f.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
  f.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'mutable' });
  await expect(f.runtime.ensure('pod-one', f.request, () => {})).rejects.toThrow(
    'managed-dependency-cache-unavailable',
  );
  expect(f.binding.attachQuota).not.toHaveBeenCalled();
});

it('does not export artifacts after a nonzero managed agent exit', async () => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      observedExit: true,
      state: 'exited',
      consumedTokens: 12,
      specDigest: f.request.executionSpecDigest,
      exitCode: 1,
    }),
    stderr: '',
  });

  await expect(
    f.runtime.extractOutput('container-one', '/staging', f.request.outputs.artifacts),
  ).rejects.toThrow('managed-agent-exit-failed');
  expect(f.binding.manager.extractManagedOutput).not.toHaveBeenCalled();
});

it('projects only an allowlisted channel request-limit diagnostic after exit', async () => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      observedExit: true,
      state: 'exited',
      consumedTokens: 12,
      specDigest: f.request.executionSpecDigest,
      exitCode: 1,
    }),
    stderr: '',
  });
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      phase: 'request',
      reason: 'request-limit',
      actualBytes: 140 * 1024,
      maximumBytes: 128 * 1024,
      privatePayload: 'must-not-be-projected',
    }),
    stderr: '',
  });

  await expect(f.runtime.observe('container-one')).resolves.toEqual({
    state: 'stopped',
    consumedTokens: 12,
    exitCode: 1,
    limitation: 'agent-request-limit-reached',
  });
});

it('projects only an allowlisted unsupported auto-compaction diagnostic after exit', async () => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      observedExit: true,
      state: 'exited',
      consumedTokens: 12,
      specDigest: f.request.executionSpecDigest,
      exitCode: 1,
    }),
    stderr: '',
  });
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      phase: 'request',
      reason: 'unsupported-auto-compaction',
      privatePayload: 'must-not-be-projected',
    }),
    stderr: '',
  });

  await expect(f.runtime.observe('container-one')).resolves.toEqual({
    state: 'stopped',
    consumedTokens: 12,
    exitCode: 1,
    limitation: 'agent-auto-compaction-unsupported',
  });
});

it.each([
  ['context-window-exceeded', 'agent-context-window-exceeded'],
  ['tool-permission-denied', 'agent-tool-permission-denied'],
  ['channel-unavailable', 'agent-channel-unavailable'],
  ['followup-channel-failed', 'agent-followup-channel-failed'],
  ['output-invalid', 'agent-output-invalid'],
  ['cli-exit', 'agent-cli-exit'],
] as const)('projects allowlisted agent failure %s after exit', async (reason, limitation) => {
  const f = fixture();
  await f.runtime.ensure('pod-one', f.request, () => {});
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({
      observedExit: true,
      state: 'exited',
      consumedTokens: 12,
      specDigest: f.request.executionSpecDigest,
      exitCode: 1,
    }),
    stderr: '',
  });
  f.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout: JSON.stringify({ phase: 'agent', reason, exitCode: 1, privatePayload: 'ignored' }),
    stderr: '',
  });

  await expect(f.runtime.observe('container-one')).resolves.toEqual({
    state: 'stopped',
    consumedTokens: 12,
    exitCode: 1,
    limitation,
  });
});

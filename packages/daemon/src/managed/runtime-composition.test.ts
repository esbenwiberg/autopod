import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { type ManagedFixture, fixture, resign } from '../test-utils/managed-fixture.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { BoundedResponsesTransport } from './bounded-provider.js';
import { digest } from './canonical.js';
import {
  type ManagedRuntimeCompositionConfig,
  type ManagedWorkerProviderChannel,
  composeManagedRuntime,
} from './runtime-composition.js';
let f: ManagedFixture;
let root: string;
const instances: ReturnType<typeof composeManagedRuntime>[] = [];
afterEach(() => {
  for (const item of instances.splice(0)) item.close();
  f?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
function setup(target: 'local' | 'sandbox' = 'local', mode: 'api-key' | 'chatgpt' = 'api-key') {
  f = fixture();
  root = mkdtempSync(path.join(tmpdir(), 'managed-composition-'));
  const mirror = path.join(root, 'mirror');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(root, 'init', '-b', 'main', mirror);
  git(mirror, 'config', 'user.name', 'Fixture');
  git(mirror, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(mirror, 'README.md'), 'A frozen fact.\n');
  git(mirror, 'add', 'README.md');
  git(mirror, 'commit', '-m', 'fixture');
  const base = git(mirror, 'rev-parse', 'HEAD');
  const request = f.request;
  request.effectiveGrant.scope.repositories[0]!.baseRevision = base;
  request.profileSnapshot.scope.repositories[0]!.baseRevision = base;
  request.route.executionTarget = target;
  request.profileSnapshot.route.executionTarget = target;
  request.effectiveGrant.route.executionTarget = target;
  request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(request.profileSnapshot).filter(([k]) => k !== 'snapshotDigest'),
    ),
  );
  request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
  resign(request);
  let attached: Parameters<ManagedWorkerProviderChannel['attach']>[0] | undefined;
  const channel = {
    preflight: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    attach: vi.fn(async (binding: Parameters<ManagedWorkerProviderChannel['attach']>[0]) => {
      attached = binding;
      return vi.fn();
    }),
  };
  const ensure = vi.fn(async (config: ContainerSpawnConfig) => {
    config.onCreated?.('runtime-one');
    return 'runtime-one';
  });
  const exec = vi.fn(async (_ref: string, _args: string[], _options?: object) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  const manager = {
    ensureManagedContainer: ensure,
    extractManagedOutput: vi.fn(),
    execInContainer: exec,
  } as unknown as ContainerManager;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('input_tokens')
      ? Response.json({ object: 'response.input_tokens', input_tokens: 10 })
      : Response.json({
          model: request.route.model,
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'A frozen fact.' }],
            },
          ],
        }),
  );
  const credential = vi.fn(async () => ({
    accountId: request.route.providerAccountId,
    mode,
    token: 'fixture-secret',
  }));
  const binding = {
    route: request.route,
    manager,
    image: `fixture@sha256:${'a'.repeat(64)}`,
    command: ['fixture-codex-channel', '--model', request.route.model],
    transport: new BoundedResponsesTransport(request.route, mode, credential, fetcher),
    channel,
    network: () => ({ firewallScript: 'fixture-deny-all', networkName: 'fixture-network' }),
  };
  const config: ManagedRuntimeCompositionConfig = {
    db: f.db,
    admission: {
      ...f.admission,
      profiles: new Map([[request.profileSnapshot.snapshotDigest, request.profileSnapshot]]),
      targets: [target],
    },
    store: new MemoryArtifactStore(),
    stateRoot: root,
    mirrors: [
      { enrollmentId: 'fixture-repo', path: mirror, remote: 'fixture-remote', baseRevision: base },
    ],
    bindings: [binding],
  };
  const create = (enabled?: boolean) => {
    const result = composeManagedRuntime({ ...config, db: f.db, enabled });
    instances.push(result);
    return result;
  };
  return {
    request,
    channel,
    ensure,
    exec,
    fetcher,
    credential,
    config,
    create,
    mirror,
    attached: () => {
      if (!attached) throw new Error('not-attached');
      return attached;
    },
  };
}
it('defaults disabled without attaching channels or calling providers', async () => {
  const x = setup();
  const c = x.create();
  expect(c.service.health().enabled).toBe(false);
  await expect(c.service.start('installation', x.request)).rejects.toThrow('lane-disabled');
  await expect(c.resume()).rejects.toThrow('lane-disabled');
  expect(x.ensure).not.toHaveBeenCalled();
  expect(x.channel.attach).not.toHaveBeenCalled();
  expect(x.credential).not.toHaveBeenCalled();
});
it.each(['local', 'sandbox'] as const)(
  'wires %s workspaces, bounded requests and quota; restart never reallocates',
  async (target) => {
    const x = setup(target);
    const c = x.create(true);
    const handle = await c.service.start('installation', x.request);
    const volumes = x.ensure.mock.calls[0]![0].volumes!;
    expect(volumes.find((v) => v.container === '/repositories/fixture-repo')?.readOnly).toBe(true);
    expect(
      readFileSync(path.join(c.workspaces.path(handle.podId, 'fixture-repo'), 'README.md'), 'utf8'),
    ).toBe('A frozen fact.\n');
    expect(await x.attached().invoke('one', 'Read README', 100)).toEqual({
      state: 'observed',
      value: 'A frozen fact.',
    });
    expect(c.service.row('installation', handle.podId).consumed_tokens).toBe(30);
    expect(
      x.exec.mock.calls.some((call) => call[1].some((arg) => arg.endsWith('/quota.json'))),
    ).toBe(true);
    expect(JSON.stringify(x.exec.mock.calls)).not.toContain('fixture-secret');
    expect(JSON.stringify(x.ensure.mock.calls)).not.toContain('fixture-secret');
    c.close();
    f.restart();
    const reopened = x.create(true);
    await reopened.resume();
    await reopened.resume();
    expect(await x.attached().invoke('one', 'Read README', 100)).toEqual({
      state: 'observed',
      value: 'A frozen fact.',
    });
    expect(x.fetcher).toHaveBeenCalledTimes(2);
    expect(x.ensure).toHaveBeenCalledTimes(1);
    expect(x.channel.attach).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(x.mirror, 'README.md'), 'utf8')).toBe('A frozen fact.\n');
  },
);
it('ChatGPT preflight fails before workspace, pod, channel, credential or network effects', async () => {
  const x = setup('sandbox', 'chatgpt');
  const c = x.create(true);
  await expect(c.service.start('installation', x.request)).rejects.toThrow(
    'hard-token-ceiling-unavailable',
  );
  expect(f.db.prepare('SELECT count(*) AS n FROM managed_pods').get()).toEqual({ n: 0 });
  expect(x.ensure).not.toHaveBeenCalled();
  expect(x.channel.attach).not.toHaveBeenCalled();
  expect(x.credential).not.toHaveBeenCalled();
  expect(x.fetcher).not.toHaveBeenCalled();
});
it('a missing channel enforcement contract fails before allocation', async () => {
  const x = setup();
  x.channel.preflight.mockRejectedValue(new Error('channel-unavailable'));
  const c = x.create(true);
  await expect(c.service.start('installation', x.request)).rejects.toThrow('channel-unavailable');
  expect(x.ensure).not.toHaveBeenCalled();
});
it('routes a standard managed follow-up through the concrete bound channel', async () => {
  const x = setup();
  const c = x.create(true);
  const handle = await c.service.start('installation', x.request);
  const message = {
    schemaVersion: 1 as const,
    dispatcherAttemptId: x.request.dispatcherAttemptId,
    grantId: x.request.effectiveGrant.grantId,
    grantRevision: 1,
    message: 'Include falsifying evidence.',
  };

  await c.controls.send('installation', handle.podId, message, 'follow-one');

  expect(x.channel.send).toHaveBeenCalledWith(
    'runtime-one',
    `/run/dispatcher-${handle.podId}`,
    message,
    'follow-one',
  );
});
it('rejects ambiguous routes and closes the bound callback', async () => {
  const x = setup();
  expect(() =>
    composeManagedRuntime({
      ...x.config,
      bindings: [x.config.bindings[0]!, x.config.bindings[0]!],
    }),
  ).toThrow('route-ambiguous');
  const c = x.create(true);
  await c.service.start('installation', x.request);
  c.close();
  await expect(x.attached().invoke('one', 'Read README', 100)).rejects.toThrow('gateway-closed');
  expect(x.fetcher).not.toHaveBeenCalled();
});
it('revocation and a newer revision invalidate the captured channel authority', async () => {
  const x = setup();
  const c = x.create(true);
  await c.service.start('installation', x.request);
  f.db.prepare('UPDATE managed_pods SET grant_revision=2').run();
  await expect(x.attached().invoke('one', 'Read README', 100)).rejects.toThrow('stale-revision');
  f.db.prepare('UPDATE managed_pods SET revoked=1').run();
  c.close();
  f.restart();
  const reopened = x.create(true);
  await reopened.resume();
  expect(x.channel.attach).toHaveBeenCalledTimes(1);
  expect(x.fetcher).not.toHaveBeenCalled();
});

it('requires terminal revoked state and no uncertain sandbox allocation before discarding a workspace', async () => {
  const x = setup('sandbox');
  const c = x.create(true);
  await expect(c.service.start('installation', x.request, 'after-reservation')).rejects.toThrow();
  const row = c.service.lookup('installation', x.request.startKey);
  if (!row) throw new Error('fixture reservation missing');
  await c.workspaces.prepare(row.pod_id, x.request);
  expect(await c.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(false);
  f.db
    .prepare("UPDATE managed_pods SET state='killed',revoked=1,observed_exit=1 WHERE pod_id=?")
    .run(row.pod_id);
  f.db
    .prepare(
      "INSERT INTO managed_sandbox_allocations(pod_id,spec_digest,phase) VALUES (?,?,'creating')",
    )
    .run(row.pod_id, x.request.executionSpecDigest);
  expect(await c.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(false);
  f.db.prepare('DELETE FROM managed_sandbox_allocations WHERE pod_id=?').run(row.pod_id);
  expect(await c.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(true);
  expect(await c.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(true);
  expect(readFileSync(path.join(x.mirror, 'README.md'), 'utf8')).toBe('A frozen fact.\n');
  expect(x.ensure).not.toHaveBeenCalled();
  expect(x.credential).not.toHaveBeenCalled();
});

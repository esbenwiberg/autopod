import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import {
  fixture,
  type ManagedFixture,
  requestTimeFixture,
  resign,
} from '../test-utils/managed-fixture.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { type BoundedProviderTransport, BoundedResponsesTransport } from './bounded-provider.js';
import { digest } from './canonical.js';
import {
  composeManagedRuntime,
  type ManagedRuntimeCompositionConfig,
  type ManagedWorkerProviderChannel,
} from './runtime-composition.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

let f: ManagedFixture;
let root: string;
const instances: ReturnType<typeof composeManagedRuntime>[] = [];
afterEach(() => {
  for (const item of instances.splice(0)) item.close();
  f?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
function setup(
  target: 'local' | 'sandbox' = 'local',
  mode: 'api-key' | 'chatgpt' = 'api-key',
  budget: 'hard-token' | 'request-time' = 'hard-token',
) {
  f = budget === 'request-time' ? requestTimeFixture(100) : fixture();
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
  if (budget === 'request-time') {
    request.profileSnapshot.budget.expiresAt = 4102444800;
    request.effectiveGrant.budget.expiresAt = 4102444800;
  }
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
    send: vi.fn(),
    attach: vi.fn(async (binding: Parameters<ManagedWorkerProviderChannel['attach']>[0]) => {
      attached = binding;
      return vi.fn();
    }),
  };
  channel.send.mockImplementation(async function (this: unknown) {
    if (this !== channel) throw new Error('channel-send-unbound');
  });
  const ensure = vi.fn(async (config: ContainerSpawnConfig) => {
    config.onCreated?.('runtime-one');
    return 'runtime-one';
  });
  const exec = vi.fn(async (_ref: string, _args: string[], _options?: object) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  const writeFile = vi.fn<ContainerManager['writeFile']>().mockResolvedValue();
  const manager = {
    ensureManagedContainer: ensure,
    extractManagedOutput: vi.fn(),
    execInContainer: exec,
    writeFile,
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
  const transport: BoundedProviderTransport =
    budget === 'request-time'
      ? {
          budgetMode: 'request-time',
          bindingDigest: 'request-time-fixture',
          preflight: vi.fn(),
          generate: vi.fn(async () => ({ value: 'A frozen fact.', consumedTokens: 30 })),
        }
      : new BoundedResponsesTransport(request.route, mode, credential, fetcher);
  const binding = {
    route: request.route,
    manager,
    image: `fixture@sha256:${'a'.repeat(64)}`,
    command: ['fixture-codex-channel', '--model', request.route.model],
    transport,
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
    writeFile,
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
it('partitions restart attachment, observation and output collection by durable owner, not profile or runtime ID', async () => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  const launch = async (owner: string) => {
    const c = composeManagedRuntime({
      ...x.config,
      enabled: true,
      ownsInstallation: (id) => id === owner,
    });
    instances.push(c);
    try {
      return await c.service.start(owner, x.request);
    } finally {
      c.close();
    }
  };
  const a = await launch('fleet');
  const b = await launch('worker');
  f.restart();
  // Same fixture backend ref and profile; only the durable owner distinguishes the rows.
  for (const [owner, mine, other] of [
    ['fleet', a, b],
    ['worker', b, a],
  ] as const) {
    const lane = composeManagedRuntime({
      ...x.config,
      db: f.db,
      enabled: true,
      ownsInstallation: (id) => id === owner,
    });
    instances.push(lane);
    x.channel.attach.mockClear();
    await lane.resume();
    expect(x.channel.attach).toHaveBeenCalledTimes(1);
    expect(x.channel.attach.mock.calls[0]![0].podId).toBe(mine.podId);
    await expect(lane.service.start(other.dispatcherInstallationId, x.request)).rejects.toThrow(
      'not-found',
    );
    const observe = vi
      .spyOn(lane.runtime, 'observe')
      .mockResolvedValue({ state: 'running', consumedTokens: 7 });
    await lane.service.enforceExpiry();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(lane.service.row(owner, mine.podId).consumed_tokens).toBe(7);
    f.db.prepare("UPDATE managed_pods SET observed_exit=1,state='validating'").run();
    const finish = vi.spyOn(lane.pipeline, 'finish').mockResolvedValue(undefined);
    await lane.pipeline.tick();
    expect(finish.mock.calls).toEqual([[owner, mine.podId]]);
    f.db.prepare("UPDATE managed_pods SET observed_exit=0,state='running',consumed_tokens=0").run();
    lane.close();
  }
  expect(x.ensure).toHaveBeenCalledTimes(2);
});
it.each([
  'disk-full',
  'canceled',
] as const)('keeps a %s local checkpoint projection on the unallocated side of the fence', async (failure) => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  x.config.sandboxCheckpoints = true;
  const c = x.create(true);
  const repo = x.request.effectiveGrant.scope.repositories[0]!;
  const cancel = () => {
    f.db.prepare('UPDATE managed_pods SET revoked=1,stop_requested=1').run();
  };
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    if (String(args[0]).includes('.sandbox-projection-')) {
      vi.mocked(writeFile).mockReset();
      if (failure === 'disk-full') throw new Error('ENOSPC');
      cancel();
    }
    return actual.writeFile(...args);
  });
  await expect(
    c.withCheckpoint(
      { run: 'fixture', repository: repo.enrollmentId, commit: repo.baseRevision },
      x.mirror,
      (s) => s.start('native.fixture', x.request),
    ),
  ).rejects.toThrow(failure === 'disk-full' ? 'ENOSPC' : 'grant-inactive');
  const row = c.service.lookup('native.fixture', x.request.startKey)!;
  expect(row).toMatchObject({ allocation_attempted: 0, runtime_ref: null });
  expect(x.ensure).not.toHaveBeenCalled();
  cancel();
  await c.service.enforceExpiry();
  expect(c.service.row('native.fixture', row.pod_id)).toMatchObject({
    state: 'killed',
    observed_exit: 1,
  });
  expect(await c.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(true);
});

it('does not retry or infer exit after a sandbox allocation loses its response', async () => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  x.config.sandboxCheckpoints = true;
  const c = x.create(true);
  const repo = x.request.effectiveGrant.scope.repositories[0]!;
  x.ensure.mockRejectedValue(new Error('response lost'));
  await expect(
    c.withCheckpoint(
      { run: 'fixture', repository: repo.enrollmentId, commit: repo.baseRevision },
      x.mirror,
      (s) => s.start('native.fixture', x.request),
    ),
  ).rejects.toThrow('response lost');
  c.close();
  f.restart();
  const reopened = x.create(true);
  await expect(reopened.service.reconcileStart('native.fixture', x.request)).rejects.toThrow(
    'managed-sandbox-create-uncertain',
  );
  f.db.prepare('UPDATE managed_pods SET revoked=1,stop_requested=1').run();
  await reopened.service.enforceExpiry();
  const row = reopened.service.lookup('native.fixture', x.request.startKey)!;
  expect(row).toMatchObject({ allocation_attempted: 1, runtime_ref: null, observed_exit: 0 });
  expect(await reopened.runtime.cleanupUnallocated?.(row.pod_id, x.request)).toBe(false);
  expect(x.ensure).toHaveBeenCalledTimes(1);
  expect(x.channel.attach).not.toHaveBeenCalled();
});

it.each([
  'resume',
  'continuation',
] as const)('recovers an already verified worker after a crash before the running transaction (%s)', async (recovery) => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  const scope = x.request.effectiveGrant.scope.repositories[0]!;
  x.config.sandboxCheckpoints = true;
  x.config.ownsInstallation = (i) => i === 'native.fixture';
  // Ordinary configured mirror is deliberately unavailable. Only checkpoint custody works.
  x.config.mirrors = [{ ...x.config.mirrors[0]!, path: path.join(root, 'missing') }];
  const c = x.create(true);
  const order: string[] = [];
  let verified: Record<string, unknown> | undefined;
  let proof = '';
  x.ensure.mockImplementation(async (cfg) => {
    expect(c.service.row('native.fixture', cfg.podId).allocation_attempted).toBe(1);
    const src = cfg.volumes!.find((v) => v.container === '/repositories/' + scope.enrollmentId)!;
    expect(src.readOnly).toBe(true);
    expect(readFileSync(path.join(src.host, 'README.md'), 'utf8')).toBe('A frozen fact.\n');
    expect(() => readFileSync(path.join(src.host, '.git', 'HEAD'))).toThrow();
    order.push('allocated');
    cfg.onCreated?.('sandbox-1');
    return 'sandbox-1';
  });
  x.exec.mockImplementation(async (ref, cmd, opts) => {
    if (cmd[3]?.endsWith('/launch.json')) verified = JSON.parse(cmd[4]!).verifiedCheckpoint;
    if (cmd.includes('--detach')) order.push('started');
    if (cmd[3]?.includes("root/'launch.lock'")) {
      expect(ref).toBe('sandbox-1');
      expect(opts).toEqual({ user: 'root' });
      return { exitCode: 0, stdout: proof, stderr: '' };
    }
    if (cmd[2]?.includes('sandbox checkpoint verification failed')) {
      order.push('verified');
      return {
        exitCode: 0,
        stdout: createHash('sha256').update(cmd[4]!).digest('hex'),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await expect(
    c.withCheckpoint(
      { run: 'fixture', repository: scope.enrollmentId, commit: scope.baseRevision },
      x.mirror,
      (service) => service.start('native.fixture', x.request, 'after-agent-start'),
    ),
  ).rejects.toThrow('injected-after-agent-start');
  const row = c.service.lookup('native.fixture', x.request.startKey)!;
  expect(order).toEqual(['allocated', 'verified', 'started']);
  expect(row).toMatchObject({ runtime_ref: 'sandbox-1', state: 'queued' });
  expect(verified).toEqual({
    repository: scope.enrollmentId,
    commit: scope.baseRevision,
    podId: row.pod_id,
    runtimeRef: 'sandbox-1',
    specDigest: x.request.executionSpecDigest,
  });
  c.close();
  f.restart();
  const reopened = x.create(true);
  x.channel.attach.mockClear();
  const execution = {
    state: 'running',
    observedExit: false,
    specDigest: row.execution_spec_digest,
  };
  for (const bad of [
    null,
    { execution },
    { verified, execution: { ...execution, state: 'claimed' } },
    { verified, execution: { ...execution, observedExit: true } },
    { verified, execution: { ...execution, specDigest: 'other' } },
    { verified: { ...verified, runtimeRef: 'other' }, execution },
  ]) {
    proof = JSON.stringify(bad);
    await reopened.resume();
    expect(x.channel.attach).not.toHaveBeenCalled();
    expect(reopened.service.row('native.fixture', row.pod_id).state).toBe('queued');
  }
  await expect(reopened.service.reconcileStart('native.fixture', x.request)).rejects.toThrow(
    'managed-sandbox-create-uncertain',
  );
  await expect(reopened.service.start('native.fixture', x.request)).rejects.toThrow(
    'managed-sandbox-create-uncertain',
  );
  proof = JSON.stringify({ verified, execution });
  if (recovery === 'resume') await reopened.resume();
  else await reopened.service.start('native.fixture', x.request);
  await reopened.resume();
  expect((await reopened.service.reconcileStart('native.fixture', x.request))?.podId).toBe(
    row.pod_id,
  );
  expect(reopened.service.row('native.fixture', row.pod_id).state).toBe('running');
  expect(x.channel.attach).toHaveBeenCalledTimes(1);
  expect(x.attached()).toMatchObject({
    existingOnly: true,
    podId: row.pod_id,
    runtimeRef: 'sandbox-1',
  });
  expect(order).toEqual(['allocated', 'verified', 'started']);
});
it('keeps a failed queued reattachment isolated and recovers the next bound worker', async () => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  x.config.sandboxCheckpoints = true;
  const c = x.create(true);
  const repo = x.request.effectiveGrant.scope.repositories[0]!;
  const specDigest = x.request.executionSpecDigest;
  const proofs = new Map<string, string>();
  const seed = async (owner: string, runtimeRef: string) => {
    await expect(c.service.start(owner, x.request, 'after-reservation')).rejects.toThrow(
      'injected-after-reservation',
    );
    const podId = c.service.lookup(owner, x.request.startKey)!.pod_id;
    f.db
      .prepare('UPDATE managed_pods SET runtime_ref=?, allocation_attempted=1 WHERE pod_id=?')
      .run(runtimeRef, podId);
    proofs.set(
      runtimeRef,
      JSON.stringify({
        verified: {
          repository: repo.enrollmentId,
          commit: repo.baseRevision,
          podId,
          runtimeRef,
          specDigest,
        },
        execution: { state: 'running', observedExit: false, specDigest },
      }),
    );
    return podId;
  };
  const first = await seed('native.first', 'sandbox-1');
  const next = await seed('native.next', 'sandbox-2');
  f.db
    .prepare('INSERT INTO managed_results(pod_id, limitations_json) VALUES (?, ?)')
    .run(first, JSON.stringify(['managed-launch-unconfirmed']));
  x.exec.mockImplementation(async (ref) => ({ exitCode: 0, stdout: proofs.get(ref)!, stderr: '' }));
  x.channel.attach.mockRejectedValueOnce(new Error('secret fixture channel output'));

  await c.resume();

  expect(
    x.channel.attach.mock.calls.map(([{ podId, existingOnly }]) => [podId, existingOnly]),
  ).toEqual([
    [first, true],
    [next, true],
  ]);
  expect(c.controls.observe('native.first', first, '0').result).toMatchObject({
    state: 'queued',
    limitations: ['managed-launch-unconfirmed', 'managed-checkpoint-reattach-failed'],
  });
  expect(c.controls.observe('native.next', next, '0').result).toMatchObject({
    state: 'running',
    limitations: [],
  });
  expect(x.ensure).not.toHaveBeenCalled();
});

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

it('advertises deterministic validation only for an explicitly reviewed binding', () => {
  const x = setup('sandbox');
  const validation = {
    configuration: {
      phases: [{ phase: 'build' as const, command: 'npm run build', timeoutMs: 30000 }],
      workingDirectory: '',
    },
  };
  const result = composeManagedRuntime({
    ...x.config,
    enabled: true,
    bindings: x.config.bindings.map((binding) => ({ ...binding, validation })),
  });
  instances.push(result);
  expect(result.service.health().capabilities).toContain('managed-validation-v1');
});
it.each([
  'local',
  'sandbox',
] as const)('wires %s workspaces, bounded requests and quota; restart never reallocates', async (target) => {
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
  if (target === 'sandbox') {
    expect(x.writeFile.mock.calls.some((call) => call[1].endsWith('/quota.json'))).toBe(true);
    expect(
      x.exec.mock.calls.some((call) => call[1].some((arg) => arg.endsWith('/quota.json'))),
    ).toBe(false);
  } else {
    expect(
      x.exec.mock.calls.some((call) => call[1].some((arg) => arg.endsWith('/quota.json'))),
    ).toBe(true);
    expect(x.writeFile).not.toHaveBeenCalled();
  }
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
});
it('keeps the provider channel and skips the quota file for request-time workers', async () => {
  const x = setup('sandbox', 'chatgpt', 'request-time');
  const c = x.create(true);
  await c.service.start('installation', x.request);

  expect(x.channel.attach).toHaveBeenCalledTimes(1);
  expect(await x.attached().invoke('one', 'Read README', 0)).toEqual({
    state: 'observed',
    value: 'A frozen fact.',
  });
  expect(x.writeFile.mock.calls.some((call) => call[1].endsWith('/quota.json'))).toBe(false);
  expect(x.exec.mock.calls.some((call) => call[1].some((arg) => arg.endsWith('/quota.json')))).toBe(
    false,
  );
});
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

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionProvenance } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { ExecInterruptedError } from '../containers/exec-exit-evidence.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { IsolatedReviewer } from '../validation/isolated-reviewer.js';
import { ReviewerRunRepository } from '../validation/reviewer-run-repository.js';
import {
  capturePreparedDependencySnapshot,
  preparedDependenciesDirForPod,
} from './prepared-dependency-snapshot.js';
import {
  OUTSIDE_WORKSPACE_WRITES_SCRIPT,
  PREPARATION_DEPENDENCY_PROBE,
  PREPARATION_SOURCE_PROBE,
} from './repository-preparation.js';

const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
const readdirSyncSafe = (dir: string) => readdirSync(dir);
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

async function admitted(command: string | null = 'repo-owned-serial-prepare') {
  const f = createProvisioningFixture(true);
  fixtures.push(f);
  const { store, services } = createTestConfiguration(f.db);
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, f.accounts);
  const snapshots = createLaunchSnapshotRepository(f.db, store);
  f.deps.launchConfiguration = {
    read: snapshots.get,
    executionSettings: (config) =>
      resolveLaunchExecutionSettings(config, { image: `sha256:${'a'.repeat(64)}` }),
    assertCurrentCapabilities: async () => {},
    prepareEnvironment: async () => 'fixture-image',
    reviewer: new IsolatedReviewer({
      runs: new ReviewerRunRepository(f.db),
      accounts: f.accounts,
      logger: f.deps.logger,
      manager: () => f.cm,
      image: () => `fixture@sha256:${'a'.repeat(64)}`,
      readPod: (id) => f.podRepo.getOrThrow(id),
      assertAllowed: async () => {},
    }),
  };
  const manager = f.manager();
  const launch = await admitLaunch({
    request: {
      repositoryId: 'repo-a',
      task: 'Readiness production dispatch',
      overrides: { repositorySetup: { prepareCommand: command } },
    },
    actorId: 'operator',
    services,
    snapshots,
    createPod: (config) => {
      if (!manager.createResolvedSession) throw new Error('Resolved admission unavailable');
      return manager.createResolvedSession(config, 'operator').id;
    },
  });
  const state = {
    source: { head: 'a'.repeat(40), fingerprint: 'b'.repeat(64) },
    exitCode: 0 as number | undefined,
    prepareCalls: 0,
    deps: 'e'.repeat(64),
    metadataCalls: 0,
    onPrepare: async () => {},
    onMetadata: () => {},
  };
  const original = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
  vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
    if (args[1][2] === PREPARATION_SOURCE_PROBE)
      return { exitCode: 0, stdout: JSON.stringify(state.source), stderr: '' };
    if (args[1][2] === PREPARATION_DEPENDENCY_PROBE)
      return { exitCode: 0, stdout: JSON.stringify({ fingerprint: state.deps }), stderr: '' };
    if (args[1][2] === OUTSIDE_WORKSPACE_WRITES_SCRIPT)
      return { exitCode: 0, stdout: 'none\n', stderr: '' };
    if (args[1][2]?.startsWith('find /workspace'))
      return { exitCode: 0, stdout: '/workspace/node_modules\n', stderr: '' };
    if (
      args[1].some(
        (arg) => arg.startsWith('set -e\n') && arg.endsWith('\nrepo-owned-serial-prepare'),
      )
    ) {
      state.prepareCalls++;
      await state.onPrepare();
      return {
        exitCode: state.exitCode as number,
        stdout: 'dependency setup failed',
        stderr:
          'TOKEN=fixture-registry-secret https://user:password@registry.invalid/?token=fixture-url-secret',
      };
    }
    return original(...args);
  });
  f.cm.getExecutionMetadata = vi.fn(async () => {
    state.metadataCalls++;
    state.onMetadata();
    return {
      imageDigest: `sha256:${'c'.repeat(64)}`,
      memoryLimitBytes: 4 * 1024 ** 3,
      cpuLimit: 2,
      networkMode: 'fixture',
    };
  });
  vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
    yield {
      type: 'error',
      fatal: true,
      timestamp: new Date().toISOString(),
      message: 'Fixture stop after admission',
    };
  });
  const rows = () =>
    (
      f.db
        .prepare('SELECT payload FROM execution_provenance WHERE pod_id = ? ORDER BY rowid')
        .all(launch.podId) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as ExecutionProvenance);
  return { f, manager, id: launch.podId, state, rows };
}

describe('repository readiness production runtime admission', () => {
  it.each([
    'failed',
    'unknown',
    'timeout',
  ] as const)('prevents runtime spawn on %s preparation and persists safe evidence', async (outcome) => {
    const t = await admitted();
    t.state.exitCode = outcome === 'failed' ? 1 : undefined;
    if (outcome === 'timeout')
      t.state.onPrepare = async () => {
        throw new ExecInterruptedError({
          cause: 'timeout',
          cleanup: 'unverified',
          timeoutMs: 300000,
        });
      };
    await t.manager.processPod(t.id);
    expect(t.state.prepareCalls).toBe(1);
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(t.f.ctx.runtime.resume).not.toHaveBeenCalled();
    const receipt = t.rows().at(-1)!;
    expect(receipt).toMatchObject({
      status: 'blocked',
      purpose: 'coding',
      runtime: 'claude',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      capabilities: { memoryLimitBytes: 4 * 1024 ** 3, cpuLimit: 2 },
      repositoryPreparation: {
        status: outcome === 'failed' ? 'failed' : 'unverified',
        source: t.state.source,
        containerId: 'container-123',
      },
    });
    expect(receipt.repositoryPreparation?.commandHash).toMatch(/^[a-f0-9]{64}$/);
    const visible = JSON.stringify([t.rows(), t.f.podRepo.getOrThrow(t.id).failureReason]);
    for (const secret of ['fixture-registry-secret', 'fixture-url-secret', 'user:password'])
      expect(visible).not.toContain(secret);
    const reopened = t.f.reopen();
    expect(reopened.pods.executionProvenance?.latest(t.id)).toEqual(receipt);
  });

  it('starts the coding runtime only after successful preparation on the actual candidate', async () => {
    const t = await admitted();
    await t.manager.processPod(t.id);
    expect(t.state.prepareCalls).toBe(1);
    expect(t.f.ctx.runtime.spawn).toHaveBeenCalledOnce();
    expect(t.rows().at(-1)?.repositoryPreparation).toMatchObject({
      status: 'passed',
      source: t.state.source,
    });
    // #644: per-stage timing is durable in provenance and summarized in pod activity.
    const preparation = t.f.podRepo.executionProvenance?.latest(t.id)?.repositoryPreparation;
    expect(preparation?.timing).toMatchObject({
      commandMs: expect.any(Number),
      preflightMs: expect.any(Number),
      stages: [{ index: 1, label: 'repo-owned-serial-prepare' }],
    });
    const events = JSON.stringify(t.f.db.prepare('SELECT payload FROM events').all());
    expect(events).toContain('Repository preparation passed in');
  });

  describe('prepared dependency snapshots (#644)', () => {
    const previous = process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR;
    let dir: string;
    afterEach(() => {
      if (previous === undefined) delete process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR;
      else process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    function useSnapshotStore() {
      dir = mkdtempSync(join(tmpdir(), 'readiness-snapshots-'));
      process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR = dir;
    }
    function staleSnapshot(podId: string) {
      const snapshot = preparedDependenciesDirForPod(podId);
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, 'manifest.json'), '{}');
      return snapshot;
    }
    function archiveSeam(t: Awaited<ReturnType<typeof admitted>>) {
      const imports: string[] = [];
      Object.assign(t.f.cm, {
        exportPathArchive: vi.fn(async (_id: string, _path: string, file: string) => {
          writeFileSync(file, 'tar');
          return { bytes: 3, sha256: createHash('sha256').update('tar').digest('hex') };
        }),
        importPathArchive: vi.fn(async (_id: string, _file: string, target: string) => {
          imports.push(target);
        }),
      });
      return imports;
    }

    it('fresh launches discard a stale snapshot and prepare in full', async () => {
      useSnapshotStore();
      const t = await admitted();
      const imports = archiveSeam(t);
      const snapshot = staleSnapshot(t.id);
      await t.manager.processPod(t.id);
      expect(t.state.prepareCalls).toBe(1);
      expect(imports).toEqual([]);
      expect(() => readdirSyncSafe(snapshot)).toThrow();
      expect(t.rows().at(-1)?.repositoryPreparation?.reuse).toBeUndefined();
    });

    it('validation preparation never consumes a snapshot', async () => {
      useSnapshotStore();
      const t = await admitted();
      const imports = archiveSeam(t);
      t.f.podRepo.update(t.id, {
        status: 'failed',
        containerId: 'container-123',
        worktreePath: '/tmp/readiness-final-source',
        startCommitSha: 'a'.repeat(40),
      });
      const snapshot = staleSnapshot(t.id);
      await t.manager.revalidateSession(t.id, { force: true, checksOnly: true });
      expect(t.state.prepareCalls).toBe(1);
      expect(imports).toEqual([]);
      expect(readdirSyncSafe(snapshot)).toEqual(['manifest.json']);
      expect(
        t
          .rows()
          .filter((row) => row.repositoryPreparation)
          .every((row) => row.repositoryPreparation?.reuse === undefined),
      ).toBe(true);
    });

    it('a continuation on the same worktree reuses unchanged dependencies; a lockfile change forces preparation', async () => {
      useSnapshotStore();
      for (const lockChanged of [false, true]) {
        const t = await admitted();
        const imports = archiveSeam(t);
        await t.manager.processPod(t.id);
        expect(t.state.prepareCalls).toBe(1);
        const provenance = t.f.podRepo.executionProvenance?.latest(t.id);
        const captured = await capturePreparedDependencySnapshot({
          podId: t.id,
          executionTarget: 'local',
          containerId: 'container-123',
          cm: t.f.cm,
          evidence: provenance?.repositoryPreparation,
          imageDigest: provenance?.imageDigest,
        });
        expect(captured).toMatchObject({ status: 'captured' });
        if (lockChanged) t.state.deps = '9'.repeat(64);
        const worktreePath = t.f.podRepo.getOrThrow(t.id).worktreePath;
        t.f.podRepo.update(t.id, {
          status: 'queued',
          containerId: null,
          recoveryWorktreePath: worktreePath,
        });
        await t.manager.processPod(t.id);
        const preparation = t.rows().at(-1)?.repositoryPreparation;
        if (lockChanged) {
          expect(t.state.prepareCalls).toBe(2);
          expect(imports).toEqual([]);
          expect(preparation?.reuse).toEqual({
            decision: 'refused',
            reason: 'dependency-inputs-changed',
          });
        } else {
          expect(t.state.prepareCalls).toBe(1);
          expect(imports).toEqual(['/workspace']);
          expect(preparation).toMatchObject({
            status: 'passed',
            reuse: { decision: 'reused', sourceContainerId: 'container-123' },
          });
          const events = JSON.stringify(t.f.db.prepare('SELECT payload FROM events').all());
          expect(events).toContain('Reusing prepared dependencies from the previous container');
        }
        expect(() => readdirSyncSafe(preparedDependenciesDirForPod(t.id))).toThrow();
      }
    });
  });

  it('keeps no-prepare launches compatible without calling them repository-ready', async () => {
    const t = await admitted(null);
    await t.manager.processPod(t.id);
    expect(t.state.prepareCalls).toBe(0);
    expect(t.f.ctx.runtime.spawn).toHaveBeenCalledOnce();
    expect(t.rows().at(-1)?.repositoryPreparation).toMatchObject({
      status: 'not-configured',
      source: null,
    });
  });

  it('preserves legacy launches without inventing preparation proof', async () => {
    const f = createProvisioningFixture();
    fixtures.push(f);
    await f.manager().processPod('prepare');
    expect(f.ctx.runtime.spawn).toHaveBeenCalledOnce();
    expect(f.podRepo.executionProvenance?.latest('prepare')?.repositoryPreparation).toMatchObject({
      status: 'not-configured',
      source: null,
    });
    expect(
      vi
        .mocked(f.cm.execInContainer)
        .mock.calls.some(([, argv]) => argv[2] === PREPARATION_SOURCE_PROBE),
    ).toBe(false);
  });

  it('rejects source or lock drift during preparation before any coding runtime call', async () => {
    const t = await admitted();
    t.state.onPrepare = async () => {
      t.state.source.fingerprint = 'd'.repeat(64);
    };
    await t.manager.processPod(t.id);
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(t.rows().at(-1)?.repositoryPreparation?.status).toBe('unverified');
  });

  it('rejects lock drift after preparation at the final worker dispatch boundary', async () => {
    const t = await admitted();
    t.state.onMetadata = () => {
      if (t.state.metadataCalls === 2) t.state.source.fingerprint = 'e'.repeat(64);
    };
    await t.manager.processPod(t.id);
    expect(t.state.prepareCalls).toBe(1);
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(t.rows().at(-1)).toMatchObject({
      status: 'blocked',
      repositoryPreparation: { status: 'unverified' },
    });
  });

  it('does not write late preparation evidence or dispatch after generation supersession', async () => {
    const t = await admitted();
    t.state.onPrepare = async () => {
      t.f.db
        .prepare('UPDATE pods SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?')
        .run(t.id);
    };
    await t.manager.processPod(t.id);
    expect(t.state.prepareCalls).toBe(1);
    expect(t.rows()).toEqual([]);
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(t.f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(t.f.podRepo.getOrThrow(t.id).status).toBe('running');
  });

  it('prepares every final validation candidate again after source or lock changes', async () => {
    const t = await admitted();
    t.f.podRepo.update(t.id, {
      status: 'failed',
      containerId: 'container-123',
      worktreePath: '/tmp/readiness-final-source',
      startCommitSha: 'a'.repeat(40),
    });
    await t.manager.revalidateSession(t.id, { force: true, checksOnly: true });
    expect(t.state.prepareCalls, JSON.stringify(t.f.podRepo.getOrThrow(t.id).failureReason)).toBe(
      1,
    );
    expect(t.f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    const before = t
      .rows()
      .filter((row) => row.repositoryPreparation?.status === 'passed')
      .at(-1)!;
    t.state.source = { head: 'd'.repeat(40), fingerprint: 'e'.repeat(64) };
    t.f.podRepo.update(t.id, { status: 'failed' });
    await t.manager.revalidateSession(t.id, { force: true, checksOnly: true });
    expect(t.state.prepareCalls).toBe(2);
    expect(t.f.ctx.validationEngine.validate).toHaveBeenCalledTimes(2);
    const after = t
      .rows()
      .filter((row) => row.repositoryPreparation?.status === 'passed')
      .at(-1)!;
    expect(after.repositoryPreparation?.source).toEqual(t.state.source);
    expect(after.repositoryPreparation?.source).not.toEqual(before.repositoryPreparation?.source);
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });

  it('blocks final validation on unknown preparation without automatic retry or rework', async () => {
    const t = await admitted();
    t.state.exitCode = undefined;
    t.f.podRepo.update(t.id, {
      status: 'failed',
      containerId: 'container-123',
      worktreePath: '/tmp/readiness-final-source',
      startCommitSha: 'a'.repeat(40),
    });
    await t.manager.revalidateSession(t.id, { force: true, checksOnly: true });
    expect(t.state.prepareCalls, JSON.stringify(t.f.podRepo.getOrThrow(t.id).failureReason)).toBe(
      1,
    );
    expect(t.f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(t.rows().at(-1)).toMatchObject({
      purpose: 'validation',
      status: 'blocked',
      repositoryPreparation: { status: 'unverified' },
    });
    expect(t.f.podRepo.getOrThrow(t.id).lastValidationResult?.infrastructureFailure).toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
      retryable: false,
    });
  });

  it('rejects a passing validation result when its final source or lock inputs drifted', async () => {
    const t = await admitted();
    t.f.podRepo.update(t.id, {
      status: 'failed',
      containerId: 'container-123',
      worktreePath: '/tmp/readiness-final-source',
      startCommitSha: 'a'.repeat(40),
    });
    const validate = vi.mocked(t.f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(t.f.ctx.validationEngine.validate).mockImplementationOnce(async (...args) => {
      const result = await validate(...args);
      t.state.source.fingerprint = 'f'.repeat(64);
      return result;
    });
    expect(
      await t.manager.revalidateSession(t.id, { force: true, checksOnly: true }),
    ).toMatchObject({ result: 'fail' });
    expect(t.f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(t.rows().at(-1)).toMatchObject({
      status: 'blocked',
      repositoryPreparation: { status: 'unverified' },
    });
    expect(t.f.podRepo.getOrThrow(t.id).lastValidationResult?.infrastructureFailure).toMatchObject({
      code: 'REPOSITORY_PREPARATION_FAILED',
      retryable: false,
    });
    expect(t.f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
});

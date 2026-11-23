import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PodStatus, RepositoryPreparationEvidence } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  capturePreparedDependencySnapshot,
  cleanupPreparedDependencies,
  consumePreparedDependencySnapshot,
  decidePreparationReuse,
  isRestorableContainerPath,
  type PreparedDependencyManifest,
  preparedDependenciesDirForPod,
  type ReuseCurrent,
  sweepPreparedDependencySnapshots,
} from './prepared-dependency-snapshot.js';

let root: string;
const envKeys = [
  'AUTOPOD_PREPARED_DEPENDENCIES_DIR',
  'AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES',
  'AUTOPOD_PREPARED_DEPENDENCIES_TOTAL_MAX_BYTES',
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'prepared-deps-'));
  process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR = path.join(root, 'store');
  process.env.AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES = String(64 * 1024);
  process.env.AUTOPOD_PREPARED_DEPENDENCIES_TOTAL_MAX_BYTES = String(128 * 1024);
});
afterEach(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(root, { recursive: true, force: true });
});

const H = (c: string) => c.repeat(64);
const evidence: RepositoryPreparationEvidence = {
  status: 'passed',
  containerId: 'old-container',
  commandHash: H('a'),
  configurationHash: H('b'),
  source: { head: 'c'.repeat(40), fingerprint: H('d') },
  exitCode: 0,
  dependencyInputs: H('e'),
  outsideWorkspaceWrites: 'none',
};
const IMAGE = `sha256:${H('f')}`;
const current = (overrides: Partial<ReuseCurrent> = {}): ReuseCurrent => ({
  podId: 'pod1',
  executionTarget: 'local',
  commandHash: H('a'),
  configurationHash: H('b'),
  dependencyInputs: H('e'),
  imageDigest: IMAGE,
  ...overrides,
});

/** Fake container: node_modules listing, archive export of fixed content, import recorder. */
function fakeContainer(paths = ['/workspace/node_modules', '/workspace/packages/a/node_modules']) {
  const cm = createMockContainerManager();
  const imported: Array<{ hostFile: string; dir: string; content: string }> = [];
  const execs: string[][] = [];
  let layoutExit = 0;
  vi.mocked(cm.execInContainer).mockImplementation(async (_id, argv) => {
    execs.push(argv);
    if (argv[2]?.startsWith('find /workspace'))
      return { exitCode: 0, stdout: `${paths.join('\n')}\n`, stderr: '' };
    if (argv[3] === 'autopod-restore-layout')
      return { exitCode: layoutExit, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const exportPathArchive = vi.fn(
    async (
      _id: string,
      containerPath: string,
      hostFile: string,
      options: { maxBytes: number; timeoutMs: number },
    ) => {
      const content = Buffer.from(`tar:${containerPath}`.padEnd(1024, '.'));
      if (content.length > options.maxBytes) throw new Error('Archive exceeds its byte limit');
      await writeFile(hostFile, content);
      return { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    },
  );
  const importPathArchive = vi.fn(async (_id: string, hostFile: string, dir: string) => {
    imported.push({ hostFile, dir, content: await readFile(hostFile, 'utf8') });
  });
  Object.assign(cm, { exportPathArchive, importPathArchive });
  return {
    cm: cm as ContainerManager & {
      exportPathArchive: typeof exportPathArchive;
      importPathArchive: typeof importPathArchive;
    },
    imported,
    execs,
    setLayoutExit: (code: number) => {
      layoutExit = code;
    },
  };
}

const capture = (cm: ContainerManager, overrides: Record<string, unknown> = {}) =>
  capturePreparedDependencySnapshot({
    podId: 'pod1',
    executionTarget: 'local',
    containerId: 'old-container',
    cm,
    evidence,
    imageDigest: IMAGE,
    ...overrides,
  });

describe('decidePreparationReuse', () => {
  const manifest: PreparedDependencyManifest = {
    version: 1,
    podId: 'pod1',
    executionTarget: 'local',
    sourceContainerId: 'old-container',
    previousStatus: 'passed',
    outsideWorkspaceWrites: 'none',
    commandHash: H('a'),
    configurationHash: H('b'),
    dependencyInputs: H('e'),
    imageDigest: IMAGE,
    createdAt: new Date().toISOString(),
    totalBytes: 1,
    archives: [
      { file: '000.tar', containerPath: '/workspace/node_modules', bytes: 1, sha256: H('0') },
    ],
  };

  it('reuses only when every input is unchanged', () => {
    expect(decidePreparationReuse(manifest, current())).toEqual({ reuse: true });
  });

  it.each([
    ['no snapshot', null, current(), 'no-snapshot'],
    [
      'lockfile/dependency inputs changed',
      manifest,
      current({ dependencyInputs: H('9') }),
      'dependency-inputs-changed',
    ],
    [
      'dependency inputs unverified',
      manifest,
      current({ dependencyInputs: null }),
      'dependency-inputs-unverified',
    ],
    ['prepare command changed', manifest, current({ commandHash: H('9') }), 'command-changed'],
    [
      'configuration changed',
      manifest,
      current({ configurationHash: H('9') }),
      'configuration-changed',
    ],
    [
      'image digest changed',
      manifest,
      current({ imageDigest: `sha256:${H('9')}` }),
      'image-changed',
    ],
    ['image digest unverified', manifest, current({ imageDigest: null }), 'image-unverified'],
    ['sandbox target', manifest, current({ executionTarget: 'sandbox' }), 'unsupported-target'],
    ['another pod', manifest, current({ podId: 'pod2' }), 'snapshot-pod-mismatch'],
    [
      'failed previous preparation',
      { ...manifest, previousStatus: 'failed' as const },
      current(),
      'previous-preparation-not-passed',
    ],
    [
      'outside-workspace writes',
      { ...manifest, outsideWorkspaceWrites: 'detected' as const },
      current(),
      'outside-workspace-writes',
    ],
  ])('refuses: %s', (_name, m, c, reason) => {
    expect(decidePreparationReuse(m, c)).toEqual({ reuse: false, reason });
  });
});

describe('prepared dependency snapshot capture', () => {
  it.each([
    [
      'failed previous preparation',
      { evidence: { ...evidence, status: 'failed' } },
      'previous-preparation-not-passed',
    ],
    [
      'unverified previous preparation',
      { evidence: { ...evidence, status: 'unverified' } },
      'previous-preparation-not-passed',
    ],
    [
      'outside-workspace writes',
      { evidence: { ...evidence, outsideWorkspaceWrites: 'detected' } },
      'outside-workspace-writes',
    ],
    [
      'unverified writes',
      { evidence: { ...evidence, outsideWorkspaceWrites: 'unverified' } },
      'outside-workspace-writes-unverified',
    ],
    ['another container', { containerId: 'other' }, 'preparation-from-another-container'],
    [
      'no dependency fingerprint',
      { evidence: { ...evidence, dependencyInputs: null } },
      'dependency-inputs-unverified',
    ],
    ['unknown image', { imageDigest: null }, 'image-unverified'],
    ['sandbox target', { executionTarget: 'sandbox' }, 'unsupported-target'],
  ])('skips for %s', async (_name, overrides, reason) => {
    const { cm } = fakeContainer();
    expect(await capture(cm, overrides)).toEqual({ status: 'skipped', reason });
    expect(cm.exportPathArchive).not.toHaveBeenCalled();
  });

  it('skips containers without the archive seam', async () => {
    expect(await capture(createMockContainerManager())).toEqual({
      status: 'skipped',
      reason: 'unsupported-target',
    });
  });

  it('round-trips: captures 0700 archives with the manifest last, restores once, then deletes', async () => {
    const { cm, imported } = fakeContainer();
    const result = await capture(cm);
    expect(result).toMatchObject({ status: 'captured', archives: 2, bytes: 2048 });
    const dir = preparedDependenciesDirForPod('pod1');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR as string)).mode & 0o777).toBe(
      0o700,
    );
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      sourceContainerId: 'old-container',
      commandHash: H('a'),
      dependencyInputs: H('e'),
      imageDigest: IMAGE,
    });

    const target = fakeContainer();
    const attempt = await consumePreparedDependencySnapshot({
      cm: target.cm,
      containerId: 'new-container',
      current: current(),
    });
    expect(attempt).toMatchObject({
      reused: true,
      sourceContainerId: 'old-container',
      restoredArchives: 2,
      restoredBytes: 2048,
    });
    expect(target.imported.map((i) => i.dir)).toEqual(['/workspace', '/workspace/packages/a']);
    expect(target.imported[1]?.content).toContain('tar:/workspace/packages/a/node_modules');
    expect(imported).toEqual([]);
    // Consumed exactly once.
    await expect(stat(dir)).rejects.toThrow();
    expect(
      await consumePreparedDependencySnapshot({
        cm: target.cm,
        containerId: 'new-container',
        current: current(),
      }),
    ).toEqual({ reused: false, reason: 'no-snapshot' });
  });

  it('refuses a changed lockfile fingerprint and deletes the snapshot', async () => {
    const { cm } = fakeContainer();
    await capture(cm);
    const target = fakeContainer();
    expect(
      await consumePreparedDependencySnapshot({
        cm: target.cm,
        containerId: 'new',
        current: current({ dependencyInputs: H('7') }),
      }),
    ).toEqual({ reused: false, reason: 'dependency-inputs-changed' });
    expect(target.cm.importPathArchive).not.toHaveBeenCalled();
    await expect(stat(preparedDependenciesDirForPod('pod1'))).rejects.toThrow();
  });

  it('refuses a corrupted archive before importing anything', async () => {
    const { cm } = fakeContainer();
    await capture(cm);
    await writeFile(path.join(preparedDependenciesDirForPod('pod1'), 'archives', '001.tar'), 'x');
    const target = fakeContainer();
    expect(
      await consumePreparedDependencySnapshot({
        cm: target.cm,
        containerId: 'new',
        current: current(),
      }),
    ).toEqual({ reused: false, reason: 'snapshot-integrity-failed' });
    expect(target.cm.importPathArchive).not.toHaveBeenCalled();
  });

  it('refuses when the workspace layout changed (missing, symlinked or populated parent)', async () => {
    const { cm } = fakeContainer();
    await capture(cm);
    const target = fakeContainer();
    target.setLayoutExit(3);
    expect(
      await consumePreparedDependencySnapshot({
        cm: target.cm,
        containerId: 'new',
        current: current(),
      }),
    ).toEqual({ reused: false, reason: 'workspace-layout-changed' });
    expect(target.cm.importPathArchive).not.toHaveBeenCalled();
  });

  it('removes partially restored directories when an import fails', async () => {
    const { cm } = fakeContainer();
    await capture(cm);
    const target = fakeContainer();
    target.cm.importPathArchive
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('putArchive failed'));
    expect(
      await consumePreparedDependencySnapshot({
        cm: target.cm,
        containerId: 'new',
        current: current(),
      }),
    ).toEqual({ reused: false, reason: 'restore-failed' });
    expect(target.execs).toContainEqual([
      'rm',
      '-rf',
      '--',
      '/workspace/node_modules',
      '/workspace/packages/a/node_modules',
    ]);
  });

  it('aborts and removes a capture above the per-pod byte limit', async () => {
    process.env.AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES = '1500';
    const { cm } = fakeContainer();
    expect(await capture(cm)).toEqual({ status: 'skipped', reason: 'size-limit-exceeded' });
    await expect(stat(preparedDependenciesDirForPod('pod1'))).rejects.toThrow();
  });

  it('respects the global cap across pods', async () => {
    process.env.AUTOPOD_PREPARED_DEPENDENCIES_TOTAL_MAX_BYTES = '2500';
    const { cm } = fakeContainer();
    expect(await capture(cm)).toMatchObject({ status: 'captured', bytes: 2048 });
    const other = await capturePreparedDependencySnapshot({
      podId: 'pod2',
      executionTarget: 'local',
      containerId: 'old-container',
      cm,
      evidence,
      imageDigest: IMAGE,
    });
    expect(other.status).toBe('skipped');
    expect(['global-cap-reached', 'size-limit-exceeded']).toContain(
      (other as { reason: string }).reason,
    );
    await expect(stat(preparedDependenciesDirForPod('pod2'))).rejects.toThrow();
  });

  it('skips capture when free host disk is low', async () => {
    process.env.AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES = String(2 ** 60);
    const { cm } = fakeContainer();
    expect(await capture(cm)).toEqual({ status: 'skipped', reason: 'low-host-disk' });
    expect(cm.exportPathArchive).not.toHaveBeenCalled();
  });

  it('removes the partial snapshot when capture times out', async () => {
    const { cm } = fakeContainer();
    cm.exportPathArchive.mockRejectedValueOnce(new Error('Archive export timed out'));
    expect(await capture(cm)).toEqual({ status: 'skipped', reason: 'capture-timed-out' });
    await expect(stat(preparedDependenciesDirForPod('pod1'))).rejects.toThrow();
  });

  it('skips unsupported node_modules paths instead of restoring outside the workspace', async () => {
    const { cm } = fakeContainer(['/workspace/node_modules', '/workspace/odd dir/node_modules']);
    expect(await capture(cm)).toEqual({ status: 'skipped', reason: 'unsupported-directory-name' });
    expect(isRestorableContainerPath('/workspace/../etc/node_modules')).toBe(false);
    expect(isRestorableContainerPath('/workspace/.git/node_modules')).toBe(false);
    expect(isRestorableContainerPath('/workspace/a/node_modules')).toBe(true);
  });

  it('cleans up on kill/delete', async () => {
    const { cm } = fakeContainer();
    await capture(cm);
    await cleanupPreparedDependencies('pod1');
    await expect(stat(preparedDependenciesDirForPod('pod1'))).rejects.toThrow();
  });
});

describe('sweepPreparedDependencySnapshots', () => {
  it('removes snapshots of missing, settled, stale or no-longer-awaiting pods', async () => {
    const { cm } = fakeContainer();
    const statuses: Record<string, PodStatus> = {
      queued: 'queued',
      paused: 'paused',
      complete: 'complete',
      killed: 'killed',
      failed: 'failed',
      runningFresh: 'running',
      runningOld: 'running',
      queuedAncient: 'queued',
    };
    for (const podId of [...Object.keys(statuses), 'missing'])
      await capturePreparedDependencySnapshot({
        podId,
        executionTarget: 'local',
        containerId: 'old-container',
        cm,
        evidence,
        imageDigest: IMAGE,
      });
    const now = Date.now();
    const age = async (podId: string, ms: number) => {
      const when = new Date(now - ms);
      await utimes(preparedDependenciesDirForPod(podId), when, when);
    };
    await age('runningOld', 20 * 60 * 1000);
    await age('queuedAncient', 25 * 60 * 60 * 1000);
    const removed = await sweepPreparedDependencySnapshots(
      (id) => (statuses[id] ? { status: statuses[id] as PodStatus } : null),
      now,
    );
    expect(removed.sort()).toEqual(
      ['complete', 'failed', 'killed', 'missing', 'queuedAncient', 'runningOld'].sort(),
    );
    expect((await readdir(process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR as string)).sort()).toEqual(
      ['paused', 'queued', 'runningFresh'],
    );
  });
});

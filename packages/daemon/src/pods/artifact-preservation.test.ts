import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'artifact-preservation-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function options() {
  return {
    containerManager: createMockContainerManager(),
    containerId: 'source-container',
    artifactRoot: root,
    generation: 3,
    isCurrent: () => true,
  };
}

describe('artifact snapshot publication', () => {
  it('publishes a complete copy and retains the prior snapshot when a later extraction fails', async () => {
    const config = options();
    vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, target) => {
        await writeFile(path.join(target, 'report.md'), 'complete report');
      },
    );
    const published = await collectArtifactSnapshot(config);
    expect(await readFile(path.join(published, 'report.md'), 'utf8')).toBe('complete report');
    vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, target) => {
        await writeFile(path.join(target, 'report.md'), 'partial overwritten report');
        throw new Error('broken archive');
      },
    );
    await expect(collectArtifactSnapshot(config)).rejects.toMatchObject({
      code: 'ARTIFACT_PRESERVATION_FAILED',
      cause: new Error('broken archive'),
    });
    expect(await readFile(path.join(published, 'report.md'), 'utf8')).toBe('complete report');
    expect((await readdir(root)).sort()).toEqual(
      [path.basename(published), `${path.basename(published)}.receipt.json`].sort(),
    );
    expect(config.containerManager.kill).not.toHaveBeenCalled();
  });

  it('forwards excludes and preserves the complete workspace by default', async () => {
    const config = options();
    await collectArtifactSnapshot(config);
    await collectArtifactSnapshot({ ...config, excludes: ['.git', 'node_modules'] });
    const calls = vi.mocked(config.containerManager.extractDirectoryFromContainer).mock.calls;
    expect(calls[0]?.[3]).toBeUndefined();
    expect(calls[1]?.[3]).toEqual(['.git', 'node_modules']);
  });

  it('does not publish a copy after its lifecycle changed', async () => {
    const config = options();
    let current = true;
    config.isCurrent = () => current;
    vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, target) => {
        await writeFile(path.join(target, 'report.md'), 'older lifecycle');
        current = false;
      },
    );
    await expect(collectArtifactSnapshot(config)).rejects.toThrow('Artifact preservation failed');
    expect(await readdir(root)).toEqual([]);
  });

  it('retains the source and never publishes a copy that completes after timeout', async () => {
    const config = options();
    let finish: () => void = () => {};
    const copyWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, target) => {
        await writeFile(path.join(target, 'report.md'), 'partial');
        await copyWait;
        await writeFile(path.join(target, 'report.md'), 'late completion');
      },
    );
    await expect(collectArtifactSnapshot({ ...config, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'ARTIFACT_PRESERVATION_FAILED',
      cause: new Error('Workspace report export timed out.'),
    });
    expect((await readdir(root)).every((name) => name.startsWith('.collect-'))).toBe(true);
    finish();
    await vi.waitFor(async () => {
      expect(await readdir(root)).toEqual([]);
    });
    expect(config.containerManager.kill).not.toHaveBeenCalled();
    expect(config.containerManager.stop).not.toHaveBeenCalled();
  });

  it('gives wakeup longer than the old shared budget and export a fresh deadline', async () => {
    const config = options();
    let beginExport!: () => void;
    let finish!: () => void;
    const wake = new Promise<void>((resolve) => {
      beginExport = resolve;
    });
    const copy = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _src, target, _exclude, extraction) => {
        markStarted();
        await wake;
        extraction?.onExportStarted?.();
        await copy;
        await writeFile(path.join(target, 'report.md'), 'complete');
      },
    );
    const stages: string[] = [];
    vi.useFakeTimers();
    const result = collectArtifactSnapshot({
      ...config,
      wakeupTimeoutMs: 150_000,
      onStage: (stage) => stages.push(stage),
    });
    await started;
    // Wakeup exceeds the old shared budget without consuming export time.
    await vi.advanceTimersByTimeAsync(125_000);
    beginExport();
    await vi.advanceTimersByTimeAsync(119_000);
    finish();
    await result;
    vi.useRealTimers();
    expect(stages).toEqual(['wakeup', 'export']);
  });

  it.each(['wakeup', 'export'] as const)(
    'attributes %s timeout and discards a late rejection without replacing a good receipt',
    async (stage) => {
      const config = options();
      const previous = await collectArtifactSnapshot(config);
      const receipt = await readFile(`${previous}.receipt.json`, 'utf8');
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let failLate!: (error: Error) => void;
      const delayed = new Promise<void>((_, reject) => {
        failLate = reject;
      });
      vi.mocked(config.containerManager.extractDirectoryFromContainer).mockImplementation(
        async (_id, _src, target, _exclude, extraction) => {
          await writeFile(path.join(target, 'partial.txt'), 'unpublished');
          if (stage === 'export') extraction?.onExportStarted?.();
          started();
          await delayed;
        },
      );
      vi.useFakeTimers();
      const result = expect(
        collectArtifactSnapshot({ ...config, wakeupTimeoutMs: 50, timeoutMs: 50 }),
      ).rejects.toMatchObject({
        code: 'ARTIFACT_PRESERVATION_FAILED',
        message: expect.stringContaining(
          stage === 'wakeup' ? 'wakeup timed out' : 'export timed out',
        ),
      });
      await ready;
      await vi.advanceTimersByTimeAsync(50);
      await result;
      failLate(new Error('late extraction rejection'));
      vi.useRealTimers();
      await vi.waitFor(async () =>
        expect((await readdir(root)).sort()).toEqual(
          [path.basename(previous), `${path.basename(previous)}.receipt.json`].sort(),
        ),
      );
      expect(await readFile(`${previous}.receipt.json`, 'utf8')).toBe(receipt);
      expect(config.containerManager.kill).not.toHaveBeenCalled();
    },
  );

  it('does not emit preparation progress after ownership changes during staging setup', async () => {
    const config = options();
    const onStage = vi.fn();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(collectArtifactSnapshot({ ...config, isCurrent, onStage })).rejects.toMatchObject({
      code: 'ARTIFACT_PRESERVATION_FAILED',
    });
    expect(onStage).not.toHaveBeenCalled();
    expect(config.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a missing container before creating an artifact path', async () => {
    const config = options();
    await mkdir(path.join(root, 'prior'));
    await expect(collectArtifactSnapshot({ ...config, containerId: null })).rejects.toThrow(
      'Artifact preservation failed',
    );
    expect(await readdir(root)).toEqual(['prior']);
    expect(config.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
  });
});

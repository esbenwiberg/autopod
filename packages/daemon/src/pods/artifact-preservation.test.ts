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
    await expect(collectArtifactSnapshot(config)).rejects.toThrow('Artifact preservation failed');
    expect(await readFile(path.join(published, 'report.md'), 'utf8')).toBe('complete report');
    expect((await readdir(root)).sort()).toEqual(
      [path.basename(published), `${path.basename(published)}.receipt.json`].sort(),
    );
    expect(config.containerManager.kill).not.toHaveBeenCalled();
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
    await expect(collectArtifactSnapshot({ ...config, timeoutMs: 10 })).rejects.toThrow(
      'Artifact preservation failed',
    );
    expect((await readdir(root)).every((name) => name.startsWith('.collect-'))).toBe(true);
    finish();
    await vi.waitFor(async () => {
      expect(await readdir(root)).toEqual([]);
    });
    expect(config.containerManager.kill).not.toHaveBeenCalled();
    expect(config.containerManager.stop).not.toHaveBeenCalled();
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

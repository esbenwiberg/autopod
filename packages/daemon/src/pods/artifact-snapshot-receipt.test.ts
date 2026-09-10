import { chmod, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'artifact-receipt-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect() {
  const containerManager = createMockContainerManager();
  vi.mocked(containerManager.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, target) => {
      await writeFile(path.join(target, 'report.md'), 'saved report');
      // Record the link itself. No access to its external target is needed.
      await symlink('/unavailable/external-target', path.join(target, 'reference'));
    },
  );
  return collectArtifactSnapshot({
    containerManager,
    containerId: 'source',
    artifactRoot: root,
    generation: 3,
    isCurrent: () => true,
  });
}

describe('artifact snapshot integrity receipts', () => {
  it.each(['bytes', 'path', 'mode', 'link', 'missing-file', 'added-file'] as const)(
    'rejects changed %s after publication',
    async (change) => {
      const snapshot = await collect();
      await expect(verifyArtifactSnapshot(snapshot, root, 3)).resolves.toBeUndefined();
      const report = path.join(snapshot, 'report.md');
      if (change === 'bytes') await writeFile(report, 'changed report');
      if (change === 'path') await rename(report, path.join(snapshot, 'renamed.md'));
      if (change === 'mode') await chmod(report, 0o700);
      if (change === 'missing-file') await rm(report);
      if (change === 'added-file') await writeFile(path.join(snapshot, 'new.md'), 'new');
      if (change === 'link') {
        await rm(path.join(snapshot, 'reference'));
        await symlink('/different/target', path.join(snapshot, 'reference'));
      }
      await expect(verifyArtifactSnapshot(snapshot, root, 3)).rejects.toMatchObject({
        code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
      });
    },
  );

  it('rejects wrong generation, wrong root and missing or oversized receipts', async () => {
    const snapshot = await collect();
    await expect(verifyArtifactSnapshot(snapshot, root, 4)).rejects.toThrow();
    await expect(verifyArtifactSnapshot(snapshot, root, 3, 1)).rejects.toThrow();
    await expect(verifyArtifactSnapshot(snapshot, path.join(root, 'other'), 3)).rejects.toThrow();
    await rm(`${snapshot}.receipt.json`);
    await expect(verifyArtifactSnapshot(snapshot, root, 3)).rejects.toThrow();
    await writeFile(`${snapshot}.receipt.json`, 'x'.repeat(4097));
    await expect(verifyArtifactSnapshot(snapshot, root, 3)).rejects.toThrow();
  });

  it('fails collection before cleanup when the bounded inventory cannot be built', async () => {
    const containerManager = createMockContainerManager();
    vi.mocked(containerManager.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, target) => {
        const report = path.join(target, 'oversized');
        await writeFile(report, '');
        await truncate(report, 1_073_741_825);
      },
    );
    await expect(
      collectArtifactSnapshot({
        containerManager,
        containerId: 'source',
        artifactRoot: root,
        generation: 3,
        isCurrent: () => true,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PRESERVATION_FAILED' });
    expect(containerManager.kill).not.toHaveBeenCalled();
  });
});

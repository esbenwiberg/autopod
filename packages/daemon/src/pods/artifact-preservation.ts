import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

/** Publish only a completed copy. A failed/expired copy never replaces a prior snapshot. */
export async function collectArtifactSnapshot(options: {
  containerManager: ContainerManager;
  containerId: string | null;
  artifactRoot: string;
  generation: number;
  isCurrent: () => boolean;
  timeoutMs?: number;
}): Promise<string> {
  const failure = () =>
    new AutopodError(
      'Artifact preservation failed. The original container is retained; retry collection before completing.',
      'ARTIFACT_PRESERVATION_FAILED',
      502,
    );
  const containerId = options.containerId;
  if (!containerId || !options.isCurrent()) throw failure();
  await mkdir(options.artifactRoot, { recursive: true });
  const staging = await mkdtemp(path.join(options.artifactRoot, '.collect-'));
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = Promise.resolve().then(() =>
    options.containerManager.extractDirectoryFromContainer(containerId, '/workspace', staging),
  );
  // A timeout cannot cancel the adapter's copy. Remove its staging directory only
  // after it actually settles, and never publish it or delete the source container.
  void copy
    .then(
      () => (expired ? rm(staging, { recursive: true, force: true }) : undefined),
      () => (expired ? rm(staging, { recursive: true, force: true }) : undefined),
    )
    .catch(() => {});
  try {
    await Promise.race([
      copy,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(failure());
        }, options.timeoutMs ?? 120_000);
      }),
    ]);
    if (!options.isCurrent()) throw failure();
    const snapshot = path.join(
      options.artifactRoot,
      `generation-${options.generation}-${randomUUID()}`,
    );
    await rename(staging, snapshot);
    return snapshot;
  } catch {
    if (!expired) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw failure();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { writeArtifactSnapshotReceipt } from './artifact-snapshot-receipt.js';

/** Publish only a completed copy. A failed/expired copy never replaces a prior snapshot. */
export async function collectArtifactSnapshot(options: {
  containerManager: ContainerManager;
  containerId: string | null;
  artifactRoot: string;
  generation: number;
  cycle?: number;
  isCurrent: () => boolean;
  timeoutMs?: number;
  /** Sandbox wakeup has its own budget; export retains the normal copy budget. */
  wakeupTimeoutMs?: number;
  onStage?: (stage: 'wakeup' | 'export') => void;
  /** ContainerManager exclude contract; omit to preserve the complete workspace. */
  excludes?: string[];
}): Promise<string> {
  let stage: 'wakeup' | 'export' = options.wakeupTimeoutMs === undefined ? 'export' : 'wakeup';
  const failure = (cause?: unknown) => {
    const error = new AutopodError(
      'Artifact preservation failed. The original container is retained; retry collection before completing.',
      'ARTIFACT_PRESERVATION_FAILED',
      502,
    );
    error.cause = cause;
    if (
      cause &&
      !(cause instanceof AutopodError && cause.code === 'ARTIFACT_PRESERVATION_FAILED')
    ) {
      const timedOut =
        cause instanceof Error &&
        (cause.message.startsWith('Retained sandbox wakeup timed out') ||
          cause.message.startsWith('Workspace report export timed out') ||
          (cause instanceof AutopodError &&
            ['SANDBOX_WAKEUP_TIMEOUT', 'AZURE_SANDBOX_TIMEOUT'].includes(cause.code)));
      const detail =
        stage === 'wakeup'
          ? timedOut
            ? 'Retained sandbox wakeup timed out while waiting for Running; check for a lock or transition.'
            : 'Retained sandbox wakeup failed; check sandbox availability.'
          : timedOut
            ? 'Workspace report export timed out.'
            : 'Workspace report export failed.';
      error.message = `${detail} Original resources retained; retry approval after resolving preservation.`;
    }
    return error;
  };
  const containerId = options.containerId;
  if (!containerId || !options.isCurrent()) throw failure();
  await mkdir(options.artifactRoot, { recursive: true });
  const staging = await mkdtemp(path.join(options.artifactRoot, '.collect-'));
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: string | undefined;
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const armDeadline = () => {
    if (timer) clearTimeout(timer);
    const ms =
      stage === 'wakeup' ? (options.wakeupTimeoutMs ?? 150_000) : (options.timeoutMs ?? 120_000);
    if (!options.isCurrent()) throw failure();
    options.onStage?.(stage);
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      rejectDeadline(
        new Error(
          stage === 'wakeup'
            ? 'Retained sandbox wakeup timed out; it may still be locked or transitioning.'
            : 'Workspace report export timed out.',
        ),
      );
    }, ms);
  };
  const copy = Promise.resolve().then(() => {
    armDeadline();
    return options.containerManager.extractDirectoryFromContainer(
      containerId,
      '/workspace',
      staging,
      options.excludes,
      {
        signal: controller.signal,
        assertCurrent: () => {
          if (expired || !options.isCurrent()) throw failure();
        },
        onExportStarted: () => {
          if (expired || !options.isCurrent()) throw failure();
          if (stage === 'wakeup') {
            stage = 'export';
            armDeadline();
          }
        },
      },
    );
  });
  // A timeout cannot cancel the adapter's copy. Remove its staging directory only
  // after it actually settles, and never publish it or delete the source container.
  void copy
    .then(
      () => (expired ? rm(staging, { recursive: true, force: true }) : undefined),
      () => (expired ? rm(staging, { recursive: true, force: true }) : undefined),
    )
    .catch(() => {});
  try {
    await Promise.race([copy, deadline]);
    if (timer) clearTimeout(timer);
    if (!options.isCurrent()) throw failure();
    snapshot = path.join(options.artifactRoot, `generation-${options.generation}-${randomUUID()}`);
    await writeArtifactSnapshotReceipt(staging, snapshot, options.generation, options.cycle ?? 0);
    if (!options.isCurrent()) throw failure();
    await rename(staging, snapshot);
    return snapshot;
  } catch (cause) {
    if (snapshot) await rm(`${snapshot}.receipt.json`, { force: true }).catch(() => {});
    if (!expired) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw failure(cause);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

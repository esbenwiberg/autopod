import path from 'node:path';
import type { Pod, ScreenshotRef, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { collectFactScreenshots, collectScreenshots } from '../validation/screenshot-collector.js';
import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';
import type { ScreenshotStore } from './screenshot-store.js';
import { requiresValidationSettlement } from './validation-recovery-policy.js';

interface ValidationEvidenceDependencies {
  logger: Pick<Logger, 'info' | 'warn'>;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
  checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult>;
  syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: Pod['executionTarget'],
  ): Promise<{ pushed: boolean }>;
  screenshotStore?: ScreenshotStore;
  hostScreenshotDir?: (podId: string) => string;
  emitActivityStatus(podId: string, message: string): void;
  formatElapsedDuration(durationMs: number): string;
}

/** Collect existing validation evidence; the caller retains results and delivery authority. */
export function createValidationEvidence(deps: ValidationEvidenceDependencies): {
  collectValidationEvidence(
    podId: string,
    pod: Pod,
    result: ValidationResult,
    validationSyncOk: boolean,
    assertCurrent?: () => void,
  ): Promise<boolean>;
} {
  const {
    logger,
    containerManagerFactory,
    checkpointSandboxWorkspaceForPod,
    syncWorkspaceBack,
    screenshotStore,
    hostScreenshotDir,
    emitActivityStatus,
    formatElapsedDuration,
  } = deps;

  async function collectValidationEvidence(
    podId: string,
    pod: Pod,
    result: ValidationResult,
    initialValidationSyncOk: boolean,
    assertCurrent: () => void = () => {},
  ): Promise<boolean> {
    if (requiresValidationSettlement({ lastValidationResult: result })) {
      emitActivityStatus(
        podId,
        'Validation termination is unverified; original source and reports retained without checkpoint or sync commands.',
      );
      return false;
    }
    assertCurrent();
    const retainedScreenshots = new Set<ScreenshotRef>();
    for (const page of result.smoke.pages)
      if (page.screenshot) retainedScreenshots.add(page.screenshot);
    for (const fact of result.factValidation?.results ?? [])
      for (const attachment of fact.attachments ?? [])
        if (attachment.screenshot) retainedScreenshots.add(attachment.screenshot);
    const collectionGuards = { retainedScreenshots, assertCurrent };
    let validationSyncOk = initialValidationSyncOk;
    const hasFactScreenshotEvidence = result.factValidation?.results.some((fact) =>
      fact.attachments?.some(
        (attachment) =>
          attachment.kind === 'screenshot' &&
          !path.isAbsolute(attachment.path) &&
          attachment.path.toLowerCase().endsWith('.png'),
      ),
    );
    const hasHostFactScreenshotEvidence = result.factValidation?.results.some(
      (fact) =>
        fact.kind === 'browser-test' &&
        fact.attachments?.some(
          (attachment) =>
            attachment.kind === 'screenshot' &&
            !path.isAbsolute(attachment.path) &&
            attachment.path.toLowerCase().endsWith('.png'),
        ),
    );
    const hasValidationScreenshots = result.smoke.pages.some((page) => page.screenshotPath);

    // Host browser facts write evidence directly to the host worktree. Collect
    // those screenshots before syncWorkspaceBack mirrors /workspace over it.
    if (pod.worktreePath && hasHostFactScreenshotEvidence && screenshotStore) {
      emitActivityStatus(podId, 'Collecting host fact evidence…');
      try {
        const screenshots = await collectFactScreenshots(
          pod.worktreePath,
          result.factValidation,
          screenshotStore,
          pod.id,
          collectionGuards,
        );
        assertCurrent();
        logger.info({ podId, count: screenshots.length }, 'Collected host fact screenshots');
      } catch (err) {
        assertCurrent();
        logger.warn({ err, podId }, 'Failed to collect host fact screenshots');
      }
    }

    // Sync workspace after validation — screenshots and build artifacts are now in /workspace
    if (pod.containerId && pod.worktreePath) {
      assertCurrent();
      emitActivityStatus(podId, 'Syncing post-validation workspace…');
      const syncStartedAt = Date.now();
      try {
        if (pod.executionTarget === 'sandbox') {
          const checkpoint = await checkpointSandboxWorkspaceForPod(pod);
          assertCurrent();
          validationSyncOk =
            checkpoint.promoted && checkpoint.materialized && checkpoint.lineageVerified;
        } else {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await syncWorkspaceBack(
            pod.containerId,
            pod.worktreePath,
            cm,
            podId,
            pod.executionTarget,
          );
          assertCurrent();
        }
        emitActivityStatus(
          podId,
          `Workspace sync complete (${formatElapsedDuration(Date.now() - syncStartedAt)})`,
        );
      } catch (err) {
        assertCurrent();
        validationSyncOk = false;
        logger.warn({ err, podId }, 'Failed to sync workspace after validation');
        emitActivityStatus(
          podId,
          `Workspace sync failed after ${formatElapsedDuration(Date.now() - syncStartedAt)} — continuing with degraded safeguards`,
        );
      }
    }

    // Collect screenshots from the host worktree and write to the on-disk store
    if (pod.worktreePath && hasValidationScreenshots && screenshotStore) {
      emitActivityStatus(podId, 'Collecting validation screenshots…');
      try {
        const screenshots = await collectScreenshots(
          pod.worktreePath,
          result.smoke.pages,
          screenshotStore,
          pod.id,
          { ...collectionGuards, allowedHostScreenshotDir: hostScreenshotDir?.(pod.id) },
        );
        assertCurrent();
        for (const ss of screenshots) {
          const page = result.smoke.pages.find(
            (p) =>
              p.path === ss.pagePath && (!p.screenshot || !retainedScreenshots.has(p.screenshot)),
          );
          if (page) {
            page.screenshot = ss.ref;
          }
        }
        const missingCount = result.smoke.pages.filter(
          (p) => p.screenshotPath && !p.screenshot,
        ).length;
        if (missingCount > 0) {
          logger.warn(
            { podId, missingCount, collectedCount: screenshots.length },
            'Validation page screenshots were reported but not collected',
          );
        }
        logger.info({ podId, count: screenshots.length }, 'Collected validation screenshots');
      } catch (err) {
        assertCurrent();
        logger.warn({ err, podId }, 'Failed to collect screenshots');
      }
    }

    if (pod.worktreePath && hasFactScreenshotEvidence && screenshotStore) {
      emitActivityStatus(
        podId,
        validationSyncOk
          ? 'Collecting synced fact evidence…'
          : 'Collecting available fact evidence after degraded sync…',
      );
      try {
        const screenshots = await collectFactScreenshots(
          pod.worktreePath,
          result.factValidation,
          screenshotStore,
          pod.id,
          collectionGuards,
        );
        assertCurrent();
        logger.info({ podId, count: screenshots.length }, 'Collected fact screenshots');
      } catch (err) {
        assertCurrent();
        logger.warn({ err, podId }, 'Failed to collect fact screenshots');
      }
    }

    assertCurrent();
    return validationSyncOk;
  }

  return { collectValidationEvidence };
}

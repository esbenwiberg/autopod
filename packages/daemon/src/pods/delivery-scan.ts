import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { DeliveryScanCaptured } from './delivery-contracts.js';

export function createDeliveryScan(captured: DeliveryScanCaptured) {
  const { repoScanner, emitActivityStatus, logger, emitBlockingSecurityScanFindings, scanRepo } =
    captured;
  async function runPushCheckpointScan(pod: Pod, profile: PodExecutionSettings): Promise<void> {
    if (!repoScanner || !pod.worktreePath) return;
    try {
      const baseRef = `origin/${pod.baseBranch ?? profile.defaultBranch ?? 'main'}`;
      const isWorkspacePod = pod.options.agentMode === 'interactive';
      emitActivityStatus(pod.id, 'Running pre-push security scan…');
      const scan = await repoScanner.scan('push', {
        podId: pod.id,
        workdir: pod.worktreePath,
        baseRef,
        profile,
        isWorkspacePod,
      });
      logger.info(
        {
          podId: pod.id,
          decision: scan.decision,
          findings: scan.findings.length,
          filesScanned: scan.filesScanned,
          filesSkipped: scan.filesSkipped,
        },
        'Pre-push security scan completed',
      );
      if (scan.decision === 'block') {
        emitBlockingSecurityScanFindings(pod.id, scan.findings);
        throw new AutopodError(
          `Pre-push security scan blocked (${scan.findings.length} finding(s))`,
          'SECURITY_SCAN_BLOCKED',
          400,
        );
      }
      if (scan.decision === 'escalate') {
        logger.warn(
          { podId: pod.id, findings: scan.findings.length },
          'Pre-push security scan flagged content; review the PR body and security_scans table',
        );
      }
    } catch (err) {
      if (err instanceof AutopodError) throw err;
      // Fail open — scanner errors must not gate validation entry.
      logger.warn({ err, podId: pod.id }, 'Pre-push security scan errored — proceeding');
    }
  }

  function getLatestPushFindings(podId: string): import('@autopod/shared').ScanFinding[] {
    if (!scanRepo) return [];
    try {
      const scans = scanRepo.getForPod(podId);
      const pushScans = scans.filter((s) => s.checkpoint === 'push');
      const latest = pushScans[pushScans.length - 1];
      return latest?.findings ?? [];
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to load security findings for PR body');
      return [];
    }
  }
  return { runPushCheckpointScan, getLatestPushFindings };
}

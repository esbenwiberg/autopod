import type {
  InjectedClaudeMdSection,
  Profile,
  ScanCheckpoint,
  ScanDecision,
  ScanFinding,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { Detector } from './detectors/detector.js';
import { createSecretlintDetector } from './detectors/secretlint-detector.js';
import { type RepoScanResult, type ScanEngine, createScanEngine } from './scan-engine.js';
import { resolvePolicy } from './scan-policy.js';
import type { ScanRepository } from './scan-repository.js';

export interface RepoScannerDeps {
  detectors?: Detector[];
  scanRepo?: ScanRepository;
  logger: Logger;
}

export interface ScanContext {
  podId: string;
  workdir: string;
  baseRef?: string;
  profile: Pick<Profile, 'securityScan'>;
  isWorkspacePod?: boolean;
}

export interface RepoScanner {
  scan(checkpoint: ScanCheckpoint, ctx: ScanContext): Promise<RepoScanResult>;
}

/**
 * Construct a `RepoScanner`. Default detector set is [secretlint] only —
 * ML detectors (pii, injection) ship in later phases and would be added here.
 *
 * If a `scanRepo` is provided, every run is persisted (one row per scan,
 * N rows per finding). The persistence is best-effort: a DB error is logged
 * but does not change the returned result.
 */
export function createRepoScanner(deps: RepoScannerDeps): RepoScanner {
  const detectors = deps.detectors ?? [createSecretlintDetector()];
  const engine: ScanEngine = createScanEngine({ detectors, logger: deps.logger });

  return {
    async scan(checkpoint: ScanCheckpoint, ctx: ScanContext): Promise<RepoScanResult> {
      const policy = resolvePolicy(ctx.profile.securityScan);
      const result = await engine.run({
        podId: ctx.podId,
        workdir: ctx.workdir,
        baseRef: ctx.baseRef,
        policy,
        checkpoint,
        isWorkspacePod: ctx.isWorkspacePod,
      });

      if (deps.scanRepo) {
        try {
          deps.scanRepo.insert({
            podId: result.podId,
            checkpoint: result.checkpoint,
            decision: result.decision,
            startedAt: result.startedAt,
            completedAt: result.completedAt,
            filesScanned: result.filesScanned,
            filesSkipped: result.filesSkipped,
            scanIncomplete: result.scanIncomplete,
            findings: result.findings,
          });
        } catch (err) {
          deps.logger.warn({ err, podId: ctx.podId }, 'Failed to persist scan result');
        }
      }

      return result;
    },
  };
}

export type { RepoScanResult, ScanCheckpoint, ScanDecision, ScanFinding, InjectedClaudeMdSection };

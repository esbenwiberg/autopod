import type {
  InjectedClaudeMdSection,
  Profile,
  ScanCheckpoint,
  ScanDecision,
  ScanFinding,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { Detector } from './detectors/detector.js';
import { createInjectionDetector } from './detectors/injection-detector.js';
import { createPiiDetector } from './detectors/pii-detector.js';
import { createSecretlintDetector } from './detectors/secretlint-detector.js';
import type { ModelManager } from './model-manager.js';
import { type RepoScanResult, type ScanEngine, createScanEngine } from './scan-engine.js';
import { resolvePolicy } from './scan-policy.js';
import type { ScanRepository } from './scan-repository.js';

export interface RepoScannerDeps {
  detectors?: Detector[];
  scanRepo?: ScanRepository;
  /**
   * Optional ModelManager — if provided, the default detector list adds
   * ML-backed PII and prompt-injection detectors. Without it, only the
   * regex/secretlint detector is wired.
   */
  modelManager?: ModelManager;
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
 * Construct a `RepoScanner`. The default detector set is built like so:
 *   - secretlint always
 *   - injection (ONNX) when `modelManager` is provided
 *   - pii (ONNX) when `modelManager` is provided
 *
 * Caller can override entirely via `detectors`. If a `scanRepo` is provided,
 * every run is persisted (one row per scan, N rows per finding). Persistence
 * is best-effort — DB errors are logged but don't change the returned result.
 */
export function createRepoScanner(deps: RepoScannerDeps): RepoScanner {
  const detectors = deps.detectors ?? defaultDetectors(deps);
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

function defaultDetectors(deps: RepoScannerDeps): Detector[] {
  const list: Detector[] = [createSecretlintDetector()];
  if (deps.modelManager) {
    list.push(createInjectionDetector({ modelManager: deps.modelManager }));
    list.push(createPiiDetector({ modelManager: deps.modelManager }));
  }
  return list;
}

export type { RepoScanResult, ScanCheckpoint, ScanDecision, ScanFinding, InjectedClaudeMdSection };

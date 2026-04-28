import type {
  InjectedClaudeMdSection,
  ScanCheckpoint,
  ScanDecision,
  ScanFinding,
  SecurityScanPolicy,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { Detector } from './detectors/detector.js';
import {
  type ScanFile,
  listAlwaysScan,
  listDiffFiles,
  listTrackedFiles,
  loadScanFiles,
  resolveBaseRef,
} from './file-walker.js';
import { decide } from './scan-policy.js';
import { buildWarningSection } from './warning-section.js';

/** Default wall-clock budgets per checkpoint. */
const DEFAULT_BUDGET_MS: Record<ScanCheckpoint, number> = {
  provisioning: 30_000,
  push: 60_000,
};

export interface ScanEngineDeps {
  detectors: Detector[];
  logger: Logger;
}

export interface RunScanInput {
  podId: string;
  workdir: string;
  /** Base ref for diff scope (e.g. 'origin/main'). Optional — `auto` scope falls back to fullTree+alwaysScan when missing. */
  baseRef?: string;
  policy: SecurityScanPolicy;
  checkpoint: ScanCheckpoint;
  /** Workspace pods rewrite block→escalate at the push checkpoint. */
  isWorkspacePod?: boolean;
  /** Override the wall-clock budget for this run (ms). */
  budgetMs?: number;
  /** Override the always-scan glob list (defaults to policy.alwaysScanPaths or DEFAULT_ALWAYS_SCAN_PATHS). */
  alwaysScanPaths?: readonly string[];
}

export interface RepoScanResult {
  podId: string;
  checkpoint: ScanCheckpoint;
  startedAt: number;
  completedAt: number;
  filesScanned: number;
  filesSkipped: number;
  scanIncomplete: boolean;
  findings: ScanFinding[];
  decision: ScanDecision;
  warningSection: InjectedClaudeMdSection | null;
}

export interface ScanEngine {
  run(input: RunScanInput): Promise<RepoScanResult>;
}

import { DEFAULT_ALWAYS_SCAN_PATHS } from './scan-policy.js';

export function createScanEngine(deps: ScanEngineDeps): ScanEngine {
  const detectorsByName = new Map(deps.detectors.map((d) => [d.name, d]));

  return {
    async run(input: RunScanInput): Promise<RepoScanResult> {
      const startedAt = Date.now();
      const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS[input.checkpoint];
      const deadline = startedAt + budgetMs;

      const checkpointPolicy =
        input.checkpoint === 'provisioning' ? input.policy.provisioning : input.policy.push;

      // Short-circuit: checkpoint disabled.
      if (!checkpointPolicy.enabled) {
        return {
          podId: input.podId,
          checkpoint: input.checkpoint,
          startedAt,
          completedAt: Date.now(),
          filesScanned: 0,
          filesSkipped: 0,
          scanIncomplete: false,
          findings: [],
          decision: 'pass',
          warningSection: null,
        };
      }

      // Resolve which detectors are active for this run.
      const activeDetectors = activeDetectorsFor(input.policy, detectorsByName);
      if (activeDetectors.length === 0) {
        return {
          podId: input.podId,
          checkpoint: input.checkpoint,
          startedAt,
          completedAt: Date.now(),
          filesScanned: 0,
          filesSkipped: 0,
          scanIncomplete: false,
          findings: [],
          decision: 'pass',
          warningSection: null,
        };
      }

      // Resolve the file set for this checkpoint.
      const { fileSet, errors, scopeDegraded } = await resolveFileSet(input);
      for (const err of errors) {
        deps.logger.warn({ err, podId: input.podId }, 'Scan file resolution warning');
      }

      const { files: scanFiles, skipped } = await loadScanFiles(input.workdir, [...fileSet]);

      // Warm up detectors concurrently.
      await Promise.all(
        activeDetectors.map(async (d) => {
          try {
            await d.warmup();
          } catch (err) {
            deps.logger.warn(
              { err, podId: input.podId, detector: d.name },
              'Detector warmup failed — continuing',
            );
          }
        }),
      );

      // Run detectors over each file, respecting the wall-clock budget.
      const findings: ScanFinding[] = [];
      let scanned = 0;
      // scopeDegraded means the requested diff couldn't be resolved against
      // any usable base ref — we scanned the alwaysScanPaths fallback only.
      // Surface that to callers via scanIncomplete so a scope-degraded scan
      // doesn't read as a clean full-coverage pass.
      let scanIncomplete = scopeDegraded;
      for (const file of scanFiles) {
        if (Date.now() > deadline) {
          scanIncomplete = true;
          deps.logger.warn(
            {
              podId: input.podId,
              filesProcessed: scanned,
              filesPending: scanFiles.length - scanned,
            },
            'Scan budget exceeded — returning partial results',
          );
          break;
        }
        for (const detector of activeDetectors) {
          try {
            const detFindings = await detector.scan(file);
            for (const f of detFindings) {
              if (passesThreshold(f, input.policy)) findings.push(f);
            }
          } catch (err) {
            deps.logger.warn(
              { err, podId: input.podId, detector: detector.name, file: file.path },
              'Detector threw on file — skipping',
            );
          }
        }
        scanned += 1;
      }

      const decision = decide({
        findings,
        checkpoint: input.checkpoint,
        policy: input.policy,
        isWorkspacePod: input.isWorkspacePod,
      });

      const warningSection = decision === 'pass' ? null : buildWarningSection(findings);

      return {
        podId: input.podId,
        checkpoint: input.checkpoint,
        startedAt,
        completedAt: Date.now(),
        filesScanned: scanned,
        filesSkipped: skipped,
        scanIncomplete,
        findings,
        decision,
        warningSection,
      };
    },
  };
}

function activeDetectorsFor(
  policy: SecurityScanPolicy,
  detectorsByName: Map<string, Detector>,
): Detector[] {
  const active: Detector[] = [];
  if (policy.detectors.secrets.enabled) {
    const d = detectorsByName.get('secrets');
    if (d) active.push(d);
  }
  if (policy.detectors.pii.enabled) {
    const d = detectorsByName.get('pii');
    if (d) active.push(d);
  }
  if (policy.detectors.injection.enabled) {
    const d = detectorsByName.get('injection');
    if (d) active.push(d);
  }
  return active;
}

function passesThreshold(finding: ScanFinding, policy: SecurityScanPolicy): boolean {
  if (finding.confidence === undefined) return true; // Non-ML detectors always pass.
  if (finding.detector === 'pii') {
    const t = policy.detectors.pii.threshold ?? 0.7;
    return finding.confidence >= t;
  }
  if (finding.detector === 'injection') {
    const t = policy.detectors.injection.threshold ?? 0.8;
    return finding.confidence >= t;
  }
  return true;
}

interface ResolvedFileSet {
  fileSet: Set<string>;
  errors: unknown[];
  /** True when a `diff`-scoped scan couldn't resolve a usable base ref and
   *  silently degraded to alwaysScanPaths only. Callers should surface this
   *  via `scanIncomplete` so the scan isn't read as full-coverage. */
  scopeDegraded: boolean;
}

async function resolveFileSet(input: RunScanInput): Promise<ResolvedFileSet> {
  const checkpointPolicy =
    input.checkpoint === 'provisioning' ? input.policy.provisioning : input.policy.push;
  const errors: unknown[] = [];
  const set = new Set<string>();
  let scopeDegraded = false;

  const alwaysScanPaths =
    input.alwaysScanPaths ?? input.policy.alwaysScanPaths ?? DEFAULT_ALWAYS_SCAN_PATHS;

  const wantsDiff =
    checkpointPolicy.scope === 'diff' ||
    (checkpointPolicy.scope === 'auto' && input.baseRef !== undefined);
  const wantsFull =
    checkpointPolicy.scope === 'full' ||
    (checkpointPolicy.scope === 'auto' && input.baseRef === undefined);

  if (wantsFull) {
    try {
      const tracked = await listTrackedFiles(input.workdir);
      for (const p of tracked) set.add(p);
    } catch (err) {
      errors.push(err);
    }
  }

  if (wantsDiff && input.baseRef) {
    // Probe what's actually present locally — at the push checkpoint
    // `origin/<feature-branch>` may not exist yet (e.g. a fix-pod whose
    // parent branch hasn't been pushed). We fall back through a small
    // chain of candidates rather than silently widening to a full-tree
    // scan — that's how a "diff" scope used to scan ~all tracked files.
    const resolved = await resolveBaseRef(input.workdir, input.baseRef);
    if (resolved) {
      try {
        const diff = await listDiffFiles(input.workdir, resolved);
        for (const p of diff) set.add(p);
        if (resolved !== input.baseRef) {
          errors.push(
            new Error(
              `Base ref '${input.baseRef}' missing locally; scanned diff vs '${resolved}' instead`,
            ),
          );
        }
      } catch (err) {
        // git diff against a verified ref still failed — degrade safely.
        errors.push(err);
        scopeDegraded = true;
      }
    } else {
      errors.push(
        new Error(
          `No usable base ref for diff scan (tried '${input.baseRef}' and standard fallbacks); scanning alwaysScanPaths only`,
        ),
      );
      scopeDegraded = true;
    }
  }

  // Always-scan list runs at provisioning regardless of scope, AND as the
  // scope-degraded fallback at any checkpoint so we still surface secrets
  // in well-known config locations.
  if (input.checkpoint === 'provisioning' || scopeDegraded) {
    try {
      const always = await listAlwaysScan(input.workdir, alwaysScanPaths);
      for (const p of always) set.add(p);
    } catch (err) {
      errors.push(err);
    }
  }

  return { fileSet: set, errors, scopeDegraded };
}

export type { ScanFile };

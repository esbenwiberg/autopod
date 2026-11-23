import type { DaemonReleaseInfo } from './release.js';
import type { RuntimeType } from './runtime.js';

/** Per-candidate observation, never a reusable runner-readiness certificate. */
export interface RepositoryPreparationEvidence {
  status: 'not-configured' | 'passed' | 'failed' | 'unverified';
  containerId: string;
  commandHash: string | null;
  /** Hash of effective workdir, timeout and environment; no resolved values are exposed. */
  configurationHash: string | null;
  source: { head: string; fingerprint: string } | null;
  exitCode: number | null;
  detail?: string;
  /** Wall-clock breakdown (#644). Absent on historical records. */
  timing?: RepositoryPreparationTiming;
  /** Package/tool cache state observed before the command ran. Absent when not observed. */
  cache?: { signals: Array<{ name: string; state: 'present' | 'absent' | 'unknown' }> };
  /** Hash of dependency manifests/lockfiles and command-named files; null when unverified. */
  dependencyInputs?: string | null;
  /** Whether the passing command wrote outside /workspace (excluding re-downloadable caches). */
  outsideWorkspaceWrites?: 'none' | 'detected' | 'unverified';
  /** Continuation reuse decision; absent when reuse was not considered. */
  reuse?: RepositoryPreparationReuse;
}

export interface RepositoryPreparationStageTiming {
  /** 1-based position among the command's top-level `&&` stages. */
  index: number;
  /** Leading non-secret command words, e.g. `npm ci`; `stage <n>` when withheld. */
  label: string;
  durationMs: number | null;
  status: 'passed' | 'failed' | 'not-run' | 'unknown';
}

export interface RepositoryPreparationTiming {
  /** Whole preparation, including probes and any reuse restore. */
  totalMs: number;
  /** Configured command exec as observed by the daemon; null when it did not run. */
  commandMs: number | null;
  /** Execution preflight run immediately before preparation, when measured by the caller. */
  preflightMs?: number | null;
  /** Source/dependency-input probes before and after the command. */
  sourceProbeMs: number | null;
  /** `unavailable` when in-container stage markers could not be read. */
  stageTiming: 'measured' | 'unavailable';
  stages: RepositoryPreparationStageTiming[];
}

export interface RepositoryPreparationReuse {
  decision: 'reused' | 'refused' | 'not-applicable';
  reason: string;
  sourceContainerId?: string;
  restoredArchives?: number;
  restoredBytes?: number;
  restoreMs?: number;
}

export interface ExecutionProvenance {
  id: string;
  version: 1 | 2;
  /** v2 distinguishes direct API and host CLI reviewer dispatch preparation. */
  surface?: 'provider-api' | 'host-cli';
  dispatchModel?: string;
  podId: string;
  taskId: string;
  executionId: string;
  generation: number;
  checkedAt: string;
  status: 'checked' | 'blocked';
  /** Absent on early v1 records; those describe coding startup. */
  purpose?: 'coding' | 'validation' | 'review' | 'completion';
  /** Absent on historical records, which probed the configured worker even for review. */
  subject?: 'worker' | 'reviewer';
  runtime: RuntimeType | null;
  model: string;
  providerId: string | null;
  providerAccountId: string | null;
  release: DaemonReleaseInfo;
  cliPath: string | null;
  cliVersion: string | null;
  imageDigest: string | null;
  contractHash: string;
  validationImplementationHash: string | null;
  /** Historical absence is unknown. Launcher checks alone never establish preparation. */
  repositoryPreparation?: RepositoryPreparationEvidence;
  capabilities: {
    streamingExec: 'supported' | 'unsupported' | 'unverified';
    memoryLimitBytes: number | null;
    cpuLimit: number | null;
    networkMode: string | null;
  };
  commands: {
    requirements: Array<{ source: string; executable: string; available: boolean | null }>;
    unresolvedSources: string[];
    deferredArtifacts: string[];
    explicitDependencies: boolean;
  };
  diagnostics: Array<{ code: string; detail: string }>;
}
export type ExecutionProvenanceInput = Omit<
  ExecutionProvenance,
  'id' | 'podId' | 'taskId' | 'executionId' | 'generation' | 'checkedAt'
>;

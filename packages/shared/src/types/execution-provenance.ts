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

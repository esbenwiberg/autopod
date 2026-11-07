export type FactArtifactChange = 'create' | 'update' | 'delete' | 'touch';
export type FactKind =
  | 'unit-test'
  | 'integration-test'
  | 'contract-test'
  | 'browser-test'
  | 'typecheck'
  | 'lint-rule'
  | 'smoke-script'
  | 'custom-command';

export interface ContractScenario {
  id: string;
  given: string[];
  when: string[];
  then: string[];
}

export interface RequiredFact {
  id: string;
  proves: string[];
  kind: FactKind;
  artifact: {
    path: string;
    change: FactArtifactChange;
  };
  command: string;
}

export interface HumanReviewItem {
  id: string;
  covers: string[];
  criterion: string;
  reason: string;
}

/** Explicit input manifest for deterministic checks. Unversioned external state is ineligible. */
export interface ValidationEvidenceManifest {
  version: 1;
  hermetic: true;
  toolchainFiles: string[];
  dependencyPaths: string[];
  environmentFiles: string[];
  environmentRevision: string;
}

export type ExecutionRequirements = {
  /** Explicit launcher dependencies for dynamic shell commands. */
  executables: string[];
  minimumMemoryBytes?: number;
  minimumCpu?: number;
} & (
  | { version: 1 }
  | {
      /** Opt-in strict prerequisites; unknown explicit launchers block execution. */
      version: 2;
      platform?: 'linux/amd64' | 'linux/arm64' | 'darwin/amd64' | 'darwin/arm64';
      requiredReferenceRepositories?: Array<{ repositoryId: string; commitSha: string }>;
      /** Unsupported until an actual worker build operation is qualified. */
      requiresImageBuild?: true;
    }
);
export interface SpecContract {
  executionRequirements?: ExecutionRequirements;
  validationEvidence?: ValidationEvidenceManifest;
  contractVersion: 1;
  title: string;
  dependsOn: string[];
  scenarios: ContractScenario[];
  requiredFacts: RequiredFact[];
  humanReview: HumanReviewItem[];
}

export interface FactEvidence {
  factId: string;
  artifactPath: string;
  command: string;
  result: 'passed' | 'failed' | 'not-run';
  notes?: string;
}

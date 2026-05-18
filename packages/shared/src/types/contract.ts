export type FactArtifactChange = 'create' | 'update' | 'touch';
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

export interface SpecContract {
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

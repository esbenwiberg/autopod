import { stringify as stringifyYaml } from 'yaml';
import type { SpecContract } from './types/contract.js';
import type {
  AdvisoryBrowserQaObservation,
  FactCheckResult,
  ValidationResult,
} from './types/validation.js';

export interface EvidenceDocumentInput {
  podId: string;
  attempt: number;
  validation: ValidationResult;
  contract?: SpecContract | null;
}

function excerpt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 8_000 ? `${trimmed.slice(0, 8_000)}\n…truncated…` : trimmed;
}

function factToEvidence(fact: FactCheckResult): Record<string, unknown> {
  return {
    id: fact.factId,
    status: fact.status ?? (fact.passed ? 'pass' : 'fail'),
    proves: fact.proves,
    kind: fact.kind,
    command: fact.command,
    exit_code: fact.exitCode,
    duration_ms: fact.durationMs,
    artifact: fact.artifact ?? {
      path: fact.artifactPath,
      exists: fact.passed,
      changed: fact.passed,
    },
    reasoning: fact.reasoning,
    stdout_excerpt: excerpt(fact.stdout),
    stderr_excerpt: excerpt(fact.stderr),
    attachments: fact.attachments ?? [],
  };
}

function advisoryObservationToEvidence(
  observation: AdvisoryBrowserQaObservation,
): Record<string, unknown> {
  return {
    id: observation.id,
    scenario_id: observation.scenarioId,
    status: observation.status,
    summary: observation.summary,
    details: observation.details,
    screenshots: observation.screenshots,
    suggested_facts: observation.suggestedFacts,
  };
}

export function buildEvidenceDocument(input: EvidenceDocumentInput): Record<string, unknown> {
  const facts = input.validation.factValidation?.results ?? [];
  const advisory = input.validation.advisoryBrowserQa;
  return {
    evidence_version: 1,
    pod_id: input.podId,
    attempt: input.attempt,
    generated_at: input.validation.timestamp,
    overall: input.validation.overall,
    contract: input.contract
      ? {
          title: input.contract.title,
          scenarios: input.contract.scenarios.map((scenario) => scenario.id),
          required_facts: input.contract.requiredFacts.map((fact) => fact.id),
          human_review: input.contract.humanReview.map((item) => item.id),
        }
      : null,
    facts: facts.map(factToEvidence),
    advisory_browser_qa: advisory
      ? {
          status: advisory.status,
          reasoning: advisory.reasoning,
          model: advisory.model,
          duration_ms: advisory.durationMs,
          screenshots: advisory.screenshots,
          observations: advisory.observations.map(advisoryObservationToEvidence),
        }
      : null,
  };
}

export function renderEvidenceYaml(input: EvidenceDocumentInput): string {
  return stringifyYaml(buildEvidenceDocument(input), {
    lineWidth: 0,
    singleQuote: false,
  });
}

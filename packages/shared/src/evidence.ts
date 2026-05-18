import { stringify as stringifyYaml } from 'yaml';
import type { SpecContract } from './types/contract.js';
import type { FactCheckResult, ValidationResult } from './types/validation.js';

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

export function buildEvidenceDocument(input: EvidenceDocumentInput): Record<string, unknown> {
  const facts = input.validation.factValidation?.results ?? [];
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
  };
}

export function renderEvidenceYaml(input: EvidenceDocumentInput): string {
  return stringifyYaml(buildEvidenceDocument(input), {
    lineWidth: 0,
    singleQuote: false,
  });
}

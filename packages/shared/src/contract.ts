import { parseDocument as parseYamlDocument } from 'yaml';
import { BriefParseError } from './errors.js';
import type {
  ContractScenario,
  FactArtifactChange,
  FactKind,
  HumanReviewItem,
  RequiredFact,
  SpecContract,
} from './types/contract.js';

const ARTIFACT_CHANGES = new Set<FactArtifactChange>(['create', 'update', 'touch']);
const FACT_KINDS = new Set<FactKind>([
  'unit-test',
  'integration-test',
  'contract-test',
  'browser-test',
  'typecheck',
  'lint-rule',
  'smoke-script',
  'custom-command',
]);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BriefParseError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BriefParseError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new BriefParseError(`${label} must be a list`);
  const strings = value.map((item, i) => asString(item, `${label}[${i}]`));
  if (strings.length === 0) throw new BriefParseError(`${label} must not be empty`);
  return strings;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new BriefParseError(`${label} must be a list`);
  return value.map((item, i) => asString(item, `${label}[${i}]`));
}

function parseScenario(value: unknown, index: number): ContractScenario {
  const obj = asObject(value, `scenarios[${index}]`);
  return {
    id: asString(obj.id, `scenarios[${index}].id`),
    given: asStringArray(obj.given, `scenarios[${index}].given`),
    when: asStringArray(obj.when, `scenarios[${index}].when`),
    then: asStringArray(obj.then, `scenarios[${index}].then`),
  };
}

function parseRequiredFact(value: unknown, index: number): RequiredFact {
  const obj = asObject(value, `required_facts[${index}]`);
  const artifact = asObject(obj.artifact, `required_facts[${index}].artifact`);
  const change = asString(artifact.change, `required_facts[${index}].artifact.change`);
  if (!ARTIFACT_CHANGES.has(change as FactArtifactChange)) {
    throw new BriefParseError(
      `required_facts[${index}].artifact.change must be one of create, update, touch`,
    );
  }
  const kind = asString(obj.kind, `required_facts[${index}].kind`);
  if (!FACT_KINDS.has(kind as FactKind)) {
    throw new BriefParseError(
      `required_facts[${index}].kind must be one of ${Array.from(FACT_KINDS).join(', ')}`,
    );
  }
  return {
    id: asString(obj.id, `required_facts[${index}].id`),
    proves: asStringArray(obj.proves, `required_facts[${index}].proves`),
    kind: kind as FactKind,
    artifact: {
      path: asString(artifact.path, `required_facts[${index}].artifact.path`),
      change: change as FactArtifactChange,
    },
    command: asString(obj.command, `required_facts[${index}].command`),
  };
}

function parseHumanReview(value: unknown, index: number): HumanReviewItem {
  const obj = asObject(value, `human_review[${index}]`);
  return {
    id: asString(obj.id, `human_review[${index}].id`),
    covers: asStringArray(obj.covers, `human_review[${index}].covers`),
    criterion: asString(obj.criterion, `human_review[${index}].criterion`),
    reason: asString(obj.reason, `human_review[${index}].reason`),
  };
}

function assertUnique(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new BriefParseError(`${label} id "${id}" is duplicated`);
    seen.add(id);
  }
}

function looksGenericCommand(command: string): boolean {
  const normalized = command.trim().replace(/^npx\s+/, '');
  return /^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|build|lint)\s*$/.test(normalized);
}

export function validateSpecContract(contract: SpecContract): void {
  assertUnique(
    contract.scenarios.map((s) => s.id),
    'scenario',
  );
  assertUnique(
    contract.requiredFacts.map((f) => f.id),
    'required fact',
  );
  assertUnique(
    contract.humanReview.map((h) => h.id),
    'human review',
  );

  const scenarioIds = new Set(contract.scenarios.map((s) => s.id));
  const covered = new Set<string>();
  for (const fact of contract.requiredFacts) {
    for (const scenarioId of fact.proves) {
      if (!scenarioIds.has(scenarioId)) {
        throw new BriefParseError(
          `required_facts "${fact.id}" proves unknown scenario "${scenarioId}"`,
        );
      }
      covered.add(scenarioId);
    }
    if (looksGenericCommand(fact.command)) {
      throw new BriefParseError(
        `required_facts "${fact.id}" uses a generic command. Point at a scenario-specific command.`,
      );
    }
  }
  for (const item of contract.humanReview) {
    for (const scenarioId of item.covers) {
      if (!scenarioIds.has(scenarioId)) {
        throw new BriefParseError(
          `human_review "${item.id}" covers unknown scenario "${scenarioId}"`,
        );
      }
      covered.add(scenarioId);
    }
  }
  for (const scenario of contract.scenarios) {
    if (!covered.has(scenario.id)) {
      throw new BriefParseError(
        `scenario "${scenario.id}" must be covered by required_facts or human_review`,
      );
    }
  }
}

export function parseSpecContract(yamlText: string): SpecContract {
  let raw: unknown;
  try {
    raw = parseYamlDocument(yamlText).toJS();
  } catch (err) {
    throw new BriefParseError(
      `contract.yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj = asObject(raw, 'contract.yaml');
  const version = obj.contract_version;
  if (version !== 1) throw new BriefParseError('contract_version must be 1');
  const contract: SpecContract = {
    contractVersion: 1,
    title: asString(obj.title, 'title'),
    dependsOn: optionalStringArray(obj.depends_on, 'depends_on'),
    scenarios: Array.isArray(obj.scenarios)
      ? obj.scenarios.map(parseScenario)
      : (() => {
          throw new BriefParseError('scenarios must be a list');
        })(),
    requiredFacts: Array.isArray(obj.required_facts)
      ? obj.required_facts.map(parseRequiredFact)
      : (() => {
          throw new BriefParseError('required_facts must be a list');
        })(),
    humanReview: Array.isArray(obj.human_review)
      ? obj.human_review.map(parseHumanReview)
      : obj.human_review == null
        ? []
        : (() => {
            throw new BriefParseError('human_review must be a list');
          })(),
  };
  validateSpecContract(contract);
  return contract;
}

import { parseDocument as parseYamlDocument } from 'yaml';
import { z } from 'zod';
import { BriefParseError } from './errors.js';
import type { SpecContract } from './types/contract.js';

export const CONTRACT_DIAGNOSTICS_VERSION = 1 as const;
export interface ContractDiagnostic {
  code: string;
  path: string;
  message: string;
  hint: string;
  source: string;
  line?: number;
  column?: number;
}
export interface ContractDiagnosticEnvelope {
  diagnosticsVersion: typeof CONTRACT_DIAGNOSTICS_VERSION;
  valid: boolean;
  contractVersion: 1;
  diagnostics: ContractDiagnostic[];
}
export interface ContractInspection {
  contract?: SpecContract;
  candidate: { title?: string; dependsOn: string[] };
  diagnostics: ContractDiagnostic[];
}

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(max));
const list = (item: z.ZodTypeAny, required = false) => z.array(item).min(required ? 1 : 0);
const scenarioFields: Record<string, z.ZodTypeAny> = {
  id: text(128),
  given: list(text(10000), true),
  when: list(text(10000), true),
};
// biome-ignore lint/suspicious/noThenProperty: contract scenarios intentionally use Given/When/Then.
scenarioFields.then = list(text(10000), true);
const scenarioSchema = z.object(scenarioFields).passthrough();
const factSchema = z
  .object({
    id: text(128),
    proves: list(text(128), true),
    kind: z.enum([
      'unit-test',
      'integration-test',
      'contract-test',
      'browser-test',
      'typecheck',
      'lint-rule',
      'smoke-script',
      'custom-command',
    ]),
    artifact: z
      .object({ path: text(500), change: z.enum(['create', 'update', 'touch']) })
      .passthrough(),
    command: text(1000),
  })
  .passthrough();
const reviewSchema = z
  .object({ id: text(128), covers: list(text(128), true), criterion: text(500), reason: text(500) })
  .passthrough();
/** Versioned canonical wire/domain schema. Unknown extension fields intentionally survive. */
export const specContractV1Schema = z
  .object({
    contractVersion: z.literal(1),
    title: text(200),
    dependsOn: list(text(128)),
    scenarios: list(scenarioSchema),
    requiredFacts: list(factSchema),
    humanReview: list(reviewSchema),
  })
  .passthrough();

function issue(
  path: string,
  code: string,
  message: string,
  hint: string,
  source = 'contract',
): ContractDiagnostic {
  return { code, path, message, hint, source };
}
function generic(command: string): boolean {
  return /^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|build|lint)\s*$/.test(
    command.replace(/^npx\s+/, ''),
  );
}
function narrowed(command: string): boolean {
  return /\s(--grep|-g)\s+\S+/.test(command) || /\s--testNamePattern(=|\s+)\S+/.test(command);
}

export function inspectSpecContract(input: unknown, source = 'contract'): ContractInspection {
  const result = specContractV1Schema.safeParse(input);
  const diagnostics: ContractDiagnostic[] = [];
  if (!result.success) {
    for (const zodIssue of result.error.issues) {
      const path = zodIssue.path.join('.');
      let code = 'CONTRACT_STRUCTURE_INVALID';
      let hint = 'Provide the required value in the documented contract-v1 format.';
      if (/^requiredFacts\.\d+\.artifact\.change$/.test(path)) {
        code = 'CONTRACT_ARTIFACT_CHANGE_INVALID';
        hint = 'Use one of create, update, or touch.';
      } else if (/^requiredFacts\.\d+\.proves$/.test(path)) {
        code = 'CONTRACT_PROVES_EMPTY';
        hint = 'List at least one declared scenario id.';
      } else if (/^requiredFacts\.\d+\.proves\.\d+$/.test(path)) {
        code = 'CONTRACT_PROVES_ENTRY_TOO_LONG';
        hint = 'Use a declared scenario id containing at most 128 characters.';
      }
      diagnostics.push(issue(path, code, zodIssue.message, hint, source));
    }
  }
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const contract = result.success ? (result.data as SpecContract) : undefined;
  // Semantic checks also inspect usable raw arrays, allowing independent errors alongside shape errors.
  const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : (contract?.scenarios ?? []);
  const facts = Array.isArray(raw.requiredFacts)
    ? raw.requiredFacts
    : (contract?.requiredFacts ?? []);
  const reviews = Array.isArray(raw.humanReview) ? raw.humanReview : (contract?.humanReview ?? []);
  const ids = (values: unknown[], key: string, label: string) => {
    const seen = new Set<string>();
    values.forEach((v, i) => {
      const id = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
      if (typeof id === 'string' && id.trim()) {
        const value = id.trim();
        if (seen.has(value))
          diagnostics.push(
            issue(
              `${label}[${i}].${key}`,
              'CONTRACT_DUPLICATE_ID',
              `Duplicate ${label} id "${value}".`,
              'Use a unique id.',
              source,
            ),
          );
        seen.add(value);
      }
    });
  };
  ids(scenarios, 'id', 'scenarios');
  ids(facts, 'id', 'requiredFacts');
  ids(reviews, 'id', 'humanReview');
  const scenarioIds = new Set(
    scenarios.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const id = (value as Record<string, unknown>).id;
      return typeof id === 'string' ? [id.trim()] : [];
    }),
  );
  const covered = new Set<string>();
  const commands = new Map<string, number[]>();
  facts.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const f = v as Record<string, unknown>;
    const proves = Array.isArray(f.proves) ? f.proves : [];
    proves.forEach((p, j) => {
      if (typeof p === 'string' && p.trim()) {
        const id = p.trim();
        if (!scenarioIds.has(id))
          diagnostics.push(
            issue(
              `requiredFacts[${i}].proves[${j}]`,
              'CONTRACT_UNKNOWN_SCENARIO',
              `Fact proves unknown scenario "${id}".`,
              'Reference a declared scenario id.',
              source,
            ),
          );
        else covered.add(id);
      }
    });
    if (typeof f.command === 'string') {
      const cmd = f.command.trim();
      if (generic(cmd))
        diagnostics.push(
          issue(
            `requiredFacts[${i}].command`,
            'CONTRACT_GENERIC_COMMAND',
            'Fact command is a generic package-manager test/build/lint command.',
            'Use a scenario-specific command.',
            source,
          ),
        );
      if (/^validate_in_browser(\s|$)/.test(cmd))
        diagnostics.push(
          issue(
            `requiredFacts[${i}].command`,
            'CONTRACT_MCP_COMMAND',
            'Fact command uses validate_in_browser MCP syntax.',
            'Use an executable browser-test command.',
            source,
          ),
        );
      const current = commands.get(cmd) ?? [];
      current.push(i);
      commands.set(cmd, current);
    }
  });
  reviews.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const covers = Array.isArray((v as Record<string, unknown>).covers)
      ? ((v as Record<string, unknown>).covers as unknown[])
      : [];
    covers.forEach((p, j) => {
      if (typeof p === 'string' && p.trim()) {
        const id = p.trim();
        if (!scenarioIds.has(id))
          diagnostics.push(
            issue(
              `humanReview[${i}].covers[${j}]`,
              'CONTRACT_UNKNOWN_SCENARIO',
              `Review covers unknown scenario "${id}".`,
              'Reference a declared scenario id.',
              source,
            ),
          );
        else covered.add(id);
      }
    });
  });
  commands.forEach((indices, cmd) => {
    if (indices.length > 1 && !narrowed(cmd))
      indices.forEach((i) =>
        diagnostics.push(
          issue(
            `requiredFacts[${i}].command`,
            'CONTRACT_DUPLICATE_BROAD_COMMAND',
            'Multiple facts share the same broad command.',
            'Split the command or narrow it with --grep/-g.',
            source,
          ),
        ),
      );
  });
  scenarios.forEach((v, i) => {
    const id = v && typeof v === 'object' ? (v as Record<string, unknown>).id : undefined;
    if (typeof id === 'string' && id.trim() && !covered.has(id.trim()))
      diagnostics.push(
        issue(
          `scenarios[${i}].id`,
          'CONTRACT_SCENARIO_UNCOVERED',
          `Scenario "${id.trim()}" is not covered.`,
          'Add it to a required fact proves list or human review covers list.',
          source,
        ),
      );
  });
  return {
    contract,
    candidate: {
      title: typeof raw.title === 'string' ? raw.title.trim() : undefined,
      dependsOn: Array.isArray(raw.dependsOn)
        ? raw.dependsOn
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [],
    },
    diagnostics,
  };
}

export function inspectSpecContractYaml(
  yamlText: string,
  source = 'contract.yaml',
): ContractInspection {
  const doc = parseYamlDocument(yamlText);
  const yamlErrors = [...doc.errors, ...doc.warnings].map((error) => {
    const diagnostic = issue(
      'document',
      'CONTRACT_YAML_INVALID',
      error.message,
      'Repair YAML document errors (including duplicate keys).',
      source,
    );
    const position = error.linePos?.[0];
    return position ? { ...diagnostic, line: position.line, column: position.col } : diagnostic;
  });
  if (yamlErrors.length) return { candidate: { dependsOn: [] }, diagnostics: yamlErrors };
  const raw = doc.toJS() as Record<string, unknown>;
  const mapped =
    raw && typeof raw === 'object'
      ? {
          contractVersion: raw.contract_version,
          title: raw.title,
          dependsOn: raw.depends_on ?? [],
          scenarios: raw.scenarios,
          requiredFacts: raw.required_facts,
          humanReview: raw.human_review ?? [],
        }
      : raw;
  return inspectSpecContract(mapped, source);
}
export function validateSpecContract(contract: SpecContract): void {
  const r = inspectSpecContract(contract);
  if (r.diagnostics.length)
    throw new BriefParseError(r.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
}
export function parseSpecContract(yamlText: string): SpecContract {
  const r = inspectSpecContractYaml(yamlText);
  if (!r.contract || r.diagnostics.length) {
    throw new BriefParseError(
      r.diagnostics
        .map((d) => {
          const path = (d.path || 'contract.yaml')
            .replace(/^requiredFacts/, 'required_facts')
            .replace(/^humanReview/, 'human_review')
            .replace(/^dependsOn/, 'depends_on')
            .replace(/\.(\d+)\./g, '[$1].');
          let message = d.message;
          if (/String must contain at most (\d+) character/.test(message))
            message = message.replace('String must contain', 'must contain');
          if (path.endsWith('.kind') && message.startsWith('Invalid enum'))
            message =
              'kind must be one of unit-test, integration-test, contract-test, browser-test, typecheck, lint-rule, smoke-script, custom-command';
          if (d.code === 'CONTRACT_MCP_COMMAND')
            message =
              'uses validate_in_browser MCP tool syntax. Use an executable browser-test command instead.';
          return `${path}${d.code === 'CONTRACT_STRUCTURE_INVALID' ? ' ' : ': '}${message} Hint: ${d.hint}`;
        })
        .join('\n'),
    );
  }
  return r.contract;
}

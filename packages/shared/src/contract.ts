import { z } from 'zod';
import { parseDocument as parseYamlDocument } from 'yaml';
import { BriefParseError } from './errors.js';
import type { SpecContract } from './types/contract.js';

export const CONTRACT_DIAGNOSTICS_VERSION = 1 as const;
export interface ContractDiagnostic {
  code: string;
  path: string;
  message: string;
  hint: string;
  source?: string;
  line?: number;
  column?: number;
}
export interface ContractDiagnosticEnvelope {
  diagnosticsVersion: typeof CONTRACT_DIAGNOSTICS_VERSION;
  valid: boolean;
  contractVersion: 1;
  diagnostics: ContractDiagnostic[];
}

const text = (max: number) => z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(max));
const list = (item: z.ZodTypeAny, required = false) => z.array(item).min(required ? 1 : 0);
const scenarioFields: Record<string, z.ZodTypeAny> = { id: text(128), given: list(text(10000), true), when: list(text(10000), true) };
scenarioFields.then = list(text(10000), true);
const scenarioSchema = z.object(scenarioFields).passthrough();
const factSchema = z.object({ id: text(128), proves: list(text(128), true), kind: z.enum(['unit-test','integration-test','contract-test','browser-test','typecheck','lint-rule','smoke-script','custom-command']), artifact: z.object({ path: text(500), change: z.enum(['create','update','touch']) }).passthrough(), command: text(1000) }).passthrough();
const reviewSchema = z.object({ id: text(128), covers: list(text(128), true), criterion: text(500), reason: text(500) }).passthrough();
/** Versioned canonical wire/domain schema. Unknown extension fields intentionally survive. */
export const specContractV1Schema = z.object({ contractVersion: z.literal(1), title: text(200), dependsOn: list(text(128)), scenarios: list(scenarioSchema), requiredFacts: list(factSchema), humanReview: list(reviewSchema) }).passthrough();

function issue(path: string, code: string, message: string, hint: string, source?: string): ContractDiagnostic {
  return { code, path, message, hint, source };
}
function generic(command: string): boolean { return /^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|build|lint)\s*$/.test(command.replace(/^npx\s+/, '')); }
function narrowed(command: string): boolean { return /\s(--grep|-g)\s+\S+/.test(command) || /\s--testNamePattern(=|\s+)\S+/.test(command); }

export function inspectSpecContract(input: unknown, source?: string): { contract?: SpecContract; diagnostics: ContractDiagnostic[] } {
  const result = specContractV1Schema.safeParse(input);
  const diagnostics: ContractDiagnostic[] = [];
  if (!result.success) for (const e of result.error.issues) diagnostics.push(issue(e.path.join('.'), 'CONTRACT_STRUCTURE_INVALID', e.message, 'Provide the required value in the documented contract-v1 format.', source));
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const contract = result.success ? result.data as SpecContract : undefined;
  // Semantic checks also inspect usable raw arrays, allowing independent errors alongside shape errors.
  const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : contract?.scenarios ?? [];
  const facts = Array.isArray(raw.requiredFacts) ? raw.requiredFacts : contract?.requiredFacts ?? [];
  const reviews = Array.isArray(raw.humanReview) ? raw.humanReview : contract?.humanReview ?? [];
  const ids = (values: unknown[], key: string, label: string) => {
    const seen = new Set<string>(); values.forEach((v, i) => { const id = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined; if (typeof id === 'string' && id.trim()) { const value=id.trim(); if (seen.has(value)) diagnostics.push(issue(`${label}[${i}].${key}`, 'CONTRACT_DUPLICATE_ID', `Duplicate ${label} id "${value}".`, 'Use a unique id.', source)); seen.add(value); } });
  };
  ids(scenarios, 'id', 'scenarios'); ids(facts, 'id', 'requiredFacts'); ids(reviews, 'id', 'humanReview');
  const scenarioIds = new Set(scenarios.flatMap(v => v && typeof v === 'object' && typeof (v as Record<string, unknown>).id === 'string' ? [(v as Record<string, string>).id.trim()] : []));
  const covered = new Set<string>(); const commands = new Map<string, number[]>();
  facts.forEach((v, i) => { if (!v || typeof v !== 'object') return; const f=v as Record<string, unknown>; const proves=Array.isArray(f.proves) ? f.proves : []; proves.forEach((p,j) => { if (typeof p === 'string' && p.trim()) { const id=p.trim(); if (!scenarioIds.has(id)) diagnostics.push(issue(`requiredFacts[${i}].proves[${j}]`, 'CONTRACT_UNKNOWN_SCENARIO', `Fact proves unknown scenario "${id}".`, 'Reference a declared scenario id.', source)); else covered.add(id); } }); if (typeof f.command === 'string') { const cmd=f.command.trim(); if (generic(cmd)) diagnostics.push(issue(`requiredFacts[${i}].command`, 'CONTRACT_GENERIC_COMMAND', 'Fact command is a generic package-manager test/build/lint command.', 'Use a scenario-specific command.', source)); if (/^validate_in_browser(\s|$)/.test(cmd)) diagnostics.push(issue(`requiredFacts[${i}].command`, 'CONTRACT_MCP_COMMAND', 'Fact command uses validate_in_browser MCP syntax.', 'Use an executable browser-test command.', source)); const current=commands.get(cmd) ?? []; current.push(i); commands.set(cmd,current); } });
  reviews.forEach((v,i) => { if (!v || typeof v !== 'object') return; const covers=Array.isArray((v as Record<string,unknown>).covers) ? (v as Record<string,unknown>).covers as unknown[] : []; covers.forEach((p,j) => { if (typeof p === 'string' && p.trim()) { const id=p.trim(); if (!scenarioIds.has(id)) diagnostics.push(issue(`humanReview[${i}].covers[${j}]`, 'CONTRACT_UNKNOWN_SCENARIO', `Review covers unknown scenario "${id}".`, 'Reference a declared scenario id.', source)); else covered.add(id); } }); });
  commands.forEach((indices, cmd) => { if (indices.length > 1 && !narrowed(cmd)) indices.forEach(i => diagnostics.push(issue(`requiredFacts[${i}].command`, 'CONTRACT_DUPLICATE_BROAD_COMMAND', 'Multiple facts share the same broad command.', 'Split the command or narrow it with --grep/-g.', source))); });
  scenarios.forEach((v,i) => { const id=v && typeof v==='object' ? (v as Record<string,unknown>).id : undefined; if (typeof id==='string' && id.trim() && !covered.has(id.trim())) diagnostics.push(issue(`scenarios[${i}].id`, 'CONTRACT_SCENARIO_UNCOVERED', `Scenario "${id.trim()}" is not covered.`, 'Add it to a required fact proves list or human review covers list.', source)); });
  return { contract, diagnostics };
}

export function inspectSpecContractYaml(yamlText: string, source = 'contract.yaml'): { contract?: SpecContract; diagnostics: ContractDiagnostic[] } {
  let doc; try { doc = parseYamlDocument(yamlText); } catch (e) { return { diagnostics:[issue('', 'CONTRACT_YAML_INVALID', String(e), 'Repair the YAML syntax.', source)] }; }
  const yamlErrors = [...doc.errors, ...doc.warnings].map(e => issue('', 'CONTRACT_YAML_INVALID', e.message, 'Repair YAML document errors (including duplicate keys).', source));
  if (yamlErrors.length) return { diagnostics: yamlErrors };
  const raw=doc.toJS() as Record<string, unknown>;
  const mapped = raw && typeof raw === 'object' ? { contractVersion: raw.contract_version, title: raw.title, dependsOn: raw.depends_on ?? [], scenarios: raw.scenarios, requiredFacts: raw.required_facts, humanReview: raw.human_review ?? [] } : raw;
  return inspectSpecContract(mapped, source);
}
export function validateSpecContract(contract: SpecContract): void { const r=inspectSpecContract(contract); if (r.diagnostics.length) throw new BriefParseError(r.diagnostics.map(d=>`${d.path}: ${d.message}`).join('\n')); }
export function parseSpecContract(yamlText: string): SpecContract {
  const r=inspectSpecContractYaml(yamlText);
  if (!r.contract || r.diagnostics.length) {
    throw new BriefParseError(r.diagnostics.map(d => {
      let path = (d.path || 'contract.yaml').replace(/^requiredFacts/, 'required_facts').replace(/^humanReview/, 'human_review').replace(/^dependsOn/, 'depends_on').replace(/\.(\d+)\./g, '[$1].');
      let message = d.message;
      if (/String must contain at most (\d+) character/.test(message)) message = message.replace('String must contain', 'must contain');
      if (path.endsWith('.kind') && message.startsWith('Invalid enum')) message = 'kind must be one of unit-test, integration-test, contract-test, browser-test, typecheck, lint-rule, smoke-script, custom-command';
      if (d.code === 'CONTRACT_MCP_COMMAND') message = 'uses validate_in_browser MCP tool syntax. Use an executable browser-test command instead.';
      return `${path}${d.code === 'CONTRACT_STRUCTURE_INVALID' ? ' ' : ': '}${message} Hint: ${d.hint}`;
    }).join('\n'));
  }
  return r.contract;
}

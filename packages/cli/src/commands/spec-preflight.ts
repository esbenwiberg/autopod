import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  type BriefFile,
  CONTRACT_DIAGNOSTICS_VERSION,
  type ContractDiagnostic,
  type SpecContract,
  inspectSpecContractYaml,
  numericPrefix,
  parseBriefs,
} from '@autopod/shared';

export interface SeriesPreflight {
  specRoot: string;
  briefsDir: string;
  briefFiles: BriefFile[];
  briefs?: ReturnType<typeof parseBriefs>;
  standaloneContract?: SpecContract;
  diagnostics: ContractDiagnostic[];
}

interface DiscoveredBrief {
  name: string;
  title?: string;
  dependsOn: string[];
}

export function resolveSpecLayout(folder: string): { specRoot: string; briefsDir: string } {
  const absolute = resolve(folder);
  if (basename(absolute) === 'briefs') {
    return { specRoot: resolve(absolute, '..'), briefsDir: absolute };
  }
  const briefs = join(absolute, 'briefs');
  return existsSync(briefs) && statSync(briefs).isDirectory()
    ? { specRoot: absolute, briefsDir: briefs }
    : { specRoot: absolute, briefsDir: absolute };
}

function diagnostic(
  source: string,
  path: string,
  code: string,
  message: string,
  hint: string,
): ContractDiagnostic {
  return { source, path, code, message, hint };
}

function inspectGraph(records: DiscoveredBrief[], source: string): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const folderNames = new Set(records.map((record) => record.name));
  const firstTitle = new Map<string, string>();
  for (const record of records) {
    const title = record.title;
    if (!title) continue;
    const previous = firstTitle.get(title);
    if (previous) {
      diagnostics.push(
        diagnostic(
          source,
          `${record.name}.title`,
          'SERIES_DUPLICATE_TITLE',
          `Brief title "${title}" is duplicated in folders "${previous}" and "${record.name}".`,
          'Give every brief a unique title.',
        ),
      );
    } else {
      firstTitle.set(title, record.name);
    }
    for (const dependency of record.dependsOn) {
      if (!folderNames.has(dependency)) {
        diagnostics.push(
          diagnostic(
            source,
            `${record.name}.depends_on`,
            'SERIES_UNKNOWN_DEPENDENCY',
            `Brief folder "${record.name}" depends on unknown sibling folder "${dependency}".`,
            'Use the exact stem of an existing sibling brief folder.',
          ),
        );
      }
    }
  }

  const usable = records.filter((record) => record.title);
  const indegree = new Map(usable.map((record) => [record.name, 0]));
  const children = new Map<string, string[]>();
  for (const record of usable) {
    for (const dependency of record.dependsOn) {
      if (!indegree.has(dependency)) continue;
      indegree.set(record.name, (indegree.get(record.name) ?? 0) + 1);
      children.set(dependency, [...(children.get(dependency) ?? []), record.name]);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([name]) => name);
  const visited = new Set<string>();
  while (ready.length > 0) {
    const name = ready.shift();
    if (!name) continue;
    visited.add(name);
    for (const child of children.get(name) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  const cycle = [...indegree.keys()].filter((name) => !visited.has(name));
  if (cycle.length > 0) {
    diagnostics.push(
      diagnostic(
        source,
        'depends_on',
        'SERIES_DEPENDENCY_CYCLE',
        `Dependency cycle detected among folders: ${cycle.join(', ')}.`,
        'Remove at least one dependency edge so the graph is acyclic.',
      ),
    );
  }
  return diagnostics;
}

export function preflightSeriesFolder(folder: string): SeriesPreflight {
  const { specRoot, briefsDir } = resolveSpecLayout(folder);
  const diagnostics: ContractDiagnostic[] = [];
  const briefFiles: BriefFile[] = [];
  if (!existsSync(briefsDir) || !statSync(briefsDir).isDirectory()) {
    return {
      specRoot,
      briefsDir,
      briefFiles,
      diagnostics: [
        diagnostic(
          briefsDir,
          '',
          'SERIES_BRIEFS_NOT_FOUND',
          'Spec folder does not exist.',
          'Pass an existing spec, briefs, brief, or contract folder.',
        ),
      ],
    };
  }

  const directYaml = join(briefsDir, 'contract.yaml');
  const directYml = join(briefsDir, 'contract.yml');
  const hasDirectContract = existsSync(directYaml) || existsSync(directYml);
  const hasDirectBrief = existsSync(join(briefsDir, 'brief.md'));
  if (hasDirectContract && !hasDirectBrief) {
    if (existsSync(directYaml) && existsSync(directYml)) {
      diagnostics.push(
        diagnostic(
          briefsDir,
          'contract',
          'SERIES_DUPLICATE_CONTRACT',
          'Both contract.yaml and contract.yml exist.',
          'Keep exactly one contract file.',
        ),
      );
      return { specRoot, briefsDir, briefFiles, diagnostics };
    }
    const path = existsSync(directYaml) ? directYaml : directYml;
    const inspection = inspectSpecContractYaml(readFileSync(path, 'utf8'), path);
    return {
      specRoot,
      briefsDir,
      briefFiles,
      standaloneContract: inspection.contract,
      diagnostics: inspection.diagnostics,
    };
  }

  const entries = hasDirectBrief
    ? ['']
    : readdirSync(briefsDir)
        .filter((name) => {
          const path = join(briefsDir, name);
          if (!statSync(path).isDirectory()) return false;
          return (
            existsSync(join(path, 'brief.md')) ||
            existsSync(join(path, 'contract.yaml')) ||
            existsSync(join(path, 'contract.yml'))
          );
        })
        .sort((a, b) => numericPrefix(a) - numericPrefix(b));
  const discovered: DiscoveredBrief[] = [];

  for (const name of entries) {
    const dir = name ? join(briefsDir, name) : briefsDir;
    const displayName = name || basename(dir);
    const briefPath = join(dir, 'brief.md');
    const yamlPath = join(dir, 'contract.yaml');
    const ymlPath = join(dir, 'contract.yml');
    if (!existsSync(briefPath)) {
      diagnostics.push(
        diagnostic(
          dir,
          'brief.md',
          'SERIES_BRIEF_MISSING',
          'Brief folder is missing brief.md.',
          'Add brief.md beside the contract.',
        ),
      );
    }
    if (existsSync(yamlPath) && existsSync(ymlPath)) {
      diagnostics.push(
        diagnostic(
          dir,
          'contract',
          'SERIES_DUPLICATE_CONTRACT',
          'Both contract.yaml and contract.yml exist.',
          'Keep exactly one contract file.',
        ),
      );
      discovered.push({ name: displayName, dependsOn: [] });
      continue;
    }
    const contractPath = existsSync(yamlPath)
      ? yamlPath
      : existsSync(ymlPath)
        ? ymlPath
        : undefined;
    if (!contractPath) {
      diagnostics.push(
        diagnostic(
          dir,
          'contract',
          'SERIES_CONTRACT_MISSING',
          'Brief folder is missing contract.yaml or contract.yml.',
          'Add one contract-v1 file.',
        ),
      );
      discovered.push({ name: displayName, dependsOn: [] });
      continue;
    }
    const contractContent = readFileSync(contractPath, 'utf8');
    const inspection = inspectSpecContractYaml(contractContent, contractPath);
    diagnostics.push(...inspection.diagnostics);
    discovered.push({
      name: displayName,
      title: inspection.candidate.title,
      dependsOn: inspection.candidate.dependsOn,
    });
    if (existsSync(briefPath)) {
      briefFiles.push({
        filename: displayName,
        content: readFileSync(briefPath, 'utf8'),
        contractContent,
      });
    }
  }
  if (entries.length === 0) {
    diagnostics.push(
      diagnostic(
        briefsDir,
        '',
        'SERIES_BRIEFS_EMPTY',
        'No contract brief folders found.',
        'Add a brief folder containing brief.md and contract.yaml.',
      ),
    );
  }
  diagnostics.push(...inspectGraph(discovered, briefsDir));

  let briefs: ReturnType<typeof parseBriefs> | undefined;
  if (diagnostics.length === 0) briefs = parseBriefs(briefFiles);
  return { specRoot, briefsDir, briefFiles, briefs, diagnostics };
}

export function preflightEnvelope(result: SeriesPreflight) {
  return {
    diagnosticsVersion: CONTRACT_DIAGNOSTICS_VERSION,
    valid: result.diagnostics.length === 0,
    contractVersion: 1 as const,
    diagnostics: result.diagnostics,
  };
}

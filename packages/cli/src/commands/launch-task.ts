import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { type LaunchRequest, type SpecFile, launchWorkSchema, parseBriefs } from '@autopod/shared';

export interface LaunchTaskFlags {
  task?: string;
  goal?: string;
  file?: string;
  spec?: string;
  includeSpecs?: boolean;
  specContext?: boolean;
  branch?: string;
  startBranch?: string;
  baseBranch?: string;
}
export function readLaunchTask(flags: LaunchTaskFlags): {
  task?: string;
  work: NonNullable<LaunchRequest['work']>;
  requiredSidecarIds?: string[];
} {
  if (
    [flags.task, flags.goal, flags.file, flags.spec].filter((value) => value !== undefined).length >
    1
  )
    throw new Error('Choose --task, --goal, --file or --spec.');
  if (flags.includeSpecs && !flags.spec) throw new Error('--include-specs requires --spec.');
  const work: NonNullable<LaunchRequest['work']> = {};
  if (flags.branch) work.branch = flags.branch;
  if (flags.startBranch) work.startBranch = flags.startBranch;
  if (flags.baseBranch) work.baseBranch = flags.baseBranch;
  if (flags.spec) {
    const root = realpathSync(resolve(flags.spec));
    // Validate the complete tree before reading any task/contract contents.
    const files = collectSpecFiles(root);
    const contractPath = resolveContractPath(root);
    const [brief] = parseBriefs([
      {
        filename: basename(root),
        content: readFileSync(join(root, 'brief.md'), 'utf8'),
        contractContent: readFileSync(contractPath, 'utf8'),
      },
    ]);
    if (!brief?.contract) throw new Error('The spec requires a valid brief and contract.');
    work.contract = launchWorkSchema.parse({ contract: brief.contract }).contract;
    work.briefTitle = brief.title;
    work.touches = brief.touches;
    work.doesNotTouch = brief.doesNotTouch;
    if (flags.includeSpecs) work.specFiles = files;
    if (flags.specContext !== false) work.specContextFiles = files;
    return { task: brief.task, work, requiredSidecarIds: brief.requireSidecars };
  }
  const task = flags.file ? readFileSync(flags.file, 'utf8').trim() : flags.task;
  if (flags.file && !task) throw new Error('Task file is empty.');
  return { task, work };
}

const pathSeparatorRegex = /[/\\]+/g;

function collectSpecFiles(specRoot: string): SpecFile[] {
  const root = realpathSync(resolve(specRoot));
  const outputRoot = `specs/${basename(root) || 'spec'}`;
  const files: SpecFile[] = [];
  let totalBytes = 0;
  let entries = 0;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      if (++entries > 2000) throw new Error('Spec tree exceeds 2000 entries.');
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`spec file symlink not allowed: ${full}`);
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      totalBytes += stat.size;
      if (files.length >= 200 || stat.size > 1_000_000 || totalBytes > 8_000_000)
        throw new Error('Spec files exceed limits: 200 files, 1 MB each, 8 MB total.');
      const real = realpathSync(full);
      const rel = relative(root, real);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`spec file outside root: ${full}`);
      }
      const outputPath = rel.split(pathSeparatorRegex).join('/');
      files.push({
        path: `${outputRoot}/${outputPath}`,
        content: readFileSync(real, 'utf-8'),
      });
    }
  }

  walk(root);
  return files;
}

function resolveContractPath(specRoot: string): string {
  const yamlPath = join(specRoot, 'contract.yaml');
  const ymlPath = join(specRoot, 'contract.yml');
  const hasYaml = existsSync(yamlPath);
  const hasYml = existsSync(ymlPath);
  if (hasYaml && hasYml) {
    throw new Error(`both contract.yaml and contract.yml found in ${specRoot}`);
  }
  if (hasYaml) return yamlPath;
  if (hasYml) return ymlPath;
  throw new Error(`contract not found: ${yamlPath} or ${ymlPath}`);
}

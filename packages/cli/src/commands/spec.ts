import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type BriefFile, numericPrefix, parseBriefs, parseSpecContract } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readContract(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`contract.yaml not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

function parseContractAt(path: string): void {
  try {
    parseSpecContract(readContract(path));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: ${message}`);
  }
}

function readSeriesBriefFiles(folderPath: string): BriefFile[] {
  const root = resolve(folderPath);
  const briefsDir =
    basename(root) === 'briefs'
      ? root
      : isDirectory(join(root, 'briefs'))
        ? join(root, 'briefs')
        : root;

  const entries = readdirSync(briefsDir);
  const briefDirs = entries
    .filter(
      (entry) =>
        isDirectory(join(briefsDir, entry)) && existsSync(join(briefsDir, entry, 'brief.md')),
    )
    .sort((a, b) => numericPrefix(a) - numericPrefix(b));

  if (briefDirs.length === 0) {
    throw new Error(`No contract brief folders found in ${briefsDir}`);
  }

  return briefDirs.map((dirname) => {
    const dir = join(briefsDir, dirname);
    const contractPath = join(dir, 'contract.yaml');
    parseContractAt(contractPath);
    return {
      filename: dirname,
      content: readFileSync(join(dir, 'brief.md'), 'utf-8'),
      contractContent: readContract(contractPath),
    };
  });
}

export function registerSpecCommands(program: Command): void {
  const spec = program.command('spec').description('Validate Autopod spec artifacts');

  spec
    .command('check <folder>')
    .description('Parse-check a /prep folder, /plan-feature folder, or investigation contract')
    .action((folder: string) => {
      const root = resolve(folder);
      if (!isDirectory(root)) {
        console.error(chalk.red(`Not a directory: ${root}`));
        process.exit(1);
      }

      try {
        const directBriefPath = join(root, 'brief.md');
        const directContractPath = join(root, 'contract.yaml');
        const hasDirectBrief = existsSync(directBriefPath);
        const hasDirectContract = existsSync(directContractPath);

        if (hasDirectBrief && hasDirectContract) {
          const [brief] = parseBriefs([
            {
              filename: basename(root),
              content: readFileSync(directBriefPath, 'utf-8'),
              contractContent: readContract(directContractPath),
            },
          ]);
          if (!brief?.contract) {
            throw new Error(`contract could not be parsed: ${directContractPath}`);
          }
          console.log(
            chalk.green(`Spec OK: 1 brief, ${brief.contract.requiredFacts.length} facts`),
          );
          return;
        }

        if (hasDirectContract) {
          parseContractAt(directContractPath);
          console.log(chalk.green('Spec OK: contract.yaml'));
          return;
        }

        const briefs = parseBriefs(readSeriesBriefFiles(root));
        const factCount = briefs.reduce(
          (count, brief) => count + (brief.contract?.requiredFacts.length ?? 0),
          0,
        );
        console.log(chalk.green(`Spec OK: ${briefs.length} briefs, ${factCount} facts`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Spec check failed: ${message}`));
        process.exit(1);
      }
    });
}

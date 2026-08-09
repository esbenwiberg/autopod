import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { type SpecFile, parseBriefs } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';
import { preflightSeriesFolder } from './spec-preflight.js';

/** Infer series name from a spec root folder path. */
function inferSeriesName(specRoot: string): string {
  return basename(resolve(specRoot));
}

/** Read a UTF-8 file relative to a base directory; return '' on any error. */
function readMaybe(baseDir: string, relPath: string): string {
  if (isAbsolute(relPath) || relPath.includes('..')) return '';
  try {
    return readFileSync(join(baseDir, relPath), 'utf-8').trim();
  } catch {
    return '';
  }
}

const pathSeparatorRegex = /[/\\]+/g;

function collectSpecFiles(specRoot: string): SpecFile[] {
  const root = realpathSync(resolve(specRoot));
  const outputRoot = `specs/${basename(root) || 'spec'}`;
  const files: SpecFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
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

export function registerSeriesCommands(program: Command, getClient: () => AutopodClient): void {
  const series = program.command('series').description('Manage series of pods');

  // ap series create <folder>
  series
    .command('create <folder>')
    .description(
      'Create a series of pods from a spec folder (containing purpose.md, design.md, and briefs/).',
    )
    .requiredOption('-p, --profile <name>', 'Profile to use for all pods')
    .option(
      '--start-branch <branch>',
      'Branch/ref to start root pods from while targeting --base-branch',
    )
    .option('-b, --base-branch <branch>', 'Base branch (default: profile default)')
    .option(
      '--pr-mode <mode>',
      'PR creation mode: single (one PR for full series), stacked (one PR per pod), none',
      'single',
    )
    .option('--series-name <name>', 'Override series name (default: derived from folder name)')
    .option('--auto-approve', 'Auto-approve each pod once it reaches validated — no human gate')
    .option(
      '--include-specs',
      'commit spec folder files onto root pod branches before agents start',
    )
    .option('--no-spec-context', 'do not expose spec folder files as runtime-only context')
    .action(
      async (
        folder: string,
        opts: {
          profile: string;
          startBranch?: string;
          baseBranch?: string;
          prMode: string;
          seriesName?: string;
          autoApprove?: boolean;
          includeSpecs?: boolean;
          specContext?: boolean;
        },
      ) => {
        // Local canonical preflight runs before client construction, credentials, or dispatch.
        const preflight = preflightSeriesFolder(folder);
        if (preflight.diagnostics.length > 0) {
          console.error(
            chalk.red(
              `Spec preflight failed:\n${preflight.diagnostics
                .map((d) => `- ${d.source ?? ''} ${d.path}: ${d.message} Hint: ${d.hint}`)
                .join('\n')}`,
            ),
          );
          process.exit(1);
        }
        const { specRoot } = preflight;
        const briefFiles = preflight.briefFiles;

        // Shared spec docs live at the spec root (parent of briefs/).
        const seriesDescription = readMaybe(specRoot, 'purpose.md');
        const seriesDesign = readMaybe(specRoot, 'design.md');
        const collectedSpecFiles = collectSpecFiles(specRoot);
        const specFiles = opts.includeSpecs ? collectedSpecFiles : undefined;
        const specContextFiles = opts.specContext === false ? undefined : collectedSpecFiles;

        const seriesName = opts.seriesName ?? inferSeriesName(specRoot);
        const prMode = opts.prMode as 'single' | 'stacked' | 'none';

        // `context_files` paths in brief frontmatter are resolved relative to
        // the spec root so a brief can pull in `decisions/...` or files at
        // the repo root via relative paths from there.
        const briefs = parseBriefs(briefFiles, (path) => readMaybe(specRoot, path));
        const client = getClient();

        console.log(
          chalk.cyan(`\nCreating series "${seriesName}" with ${briefs.length} pods...\n`),
        );

        const result = await withSpinner('Creating series...', () =>
          client.createSeries({
            seriesName,
            briefs,
            profile: opts.profile,
            startBranch: opts.startBranch,
            baseBranch: opts.baseBranch,
            specFiles,
            specContextFiles,
            prMode,
            autoApprove: opts.autoApprove ?? false,
            seriesDescription: seriesDescription || undefined,
            seriesDesign: seriesDesign || undefined,
          }),
        );

        console.log(chalk.green(`\nSeries created: ${result.seriesId}\n`));
        console.log(`  Name:    ${result.seriesName}`);
        console.log(`  PR mode: ${prMode}`);
        console.log(`  Auto-approve: ${opts.autoApprove ? 'yes' : 'no'}`);
        console.log('  Pods:\n');

        for (const pod of result.pods) {
          console.log(
            `    ${chalk.bold(pod.id.slice(0, 8))}  ${chalk.cyan((pod as unknown as { title: string }).title ?? pod.task.slice(0, 40))}  ${formatStatus(pod.status)}`,
          );
        }
        console.log(`\nTrack progress: ap series status ${result.seriesId}\n`);
      },
    );

  // ap series status <series-id>
  series
    .command('status <series-id>')
    .description('Show status of a series')
    .action(async (seriesId: string) => {
      const client = getClient();
      const result = await client.getSeries(seriesId);

      console.log(chalk.bold(`\nSeries: ${result.seriesName}`));
      console.log(`ID: ${seriesId}\n`);

      const maxStatus = Object.entries(result.statusCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([s, n]) => `${n} ${s}`)
        .join('  ·  ');
      console.log(`Status: ${maxStatus}\n`);

      for (const pod of result.pods) {
        const depLine = pod.dependsOnPodId ? `→ ${pod.dependsOnPodId.slice(0, 8)}` : '         ';
        console.log(
          `  ${chalk.bold(pod.id.slice(0, 8))}  ${formatStatus(pod.status).padEnd(20)}  ${depLine}  ${pod.task.slice(0, 50)}`,
        );
        if (pod.prUrl) {
          console.log(`             PR: ${pod.prUrl}`);
        }
      }

      const { costUsd, inputTokens, outputTokens } = result.tokenUsageSummary;
      console.log(
        `\nTotal cost: $${costUsd.toFixed(4)}  (${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out tokens)\n`,
      );
    });
}

import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { numericPrefix, parseBriefs } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';

/** Infer series name from folder path: parent dir if folder is named 'briefs', else folder name. */
function inferSeriesName(folderPath: string): string {
  const abs = resolve(folderPath);
  const name = basename(abs);
  if (name === 'briefs' || name === 'briefs/') {
    return basename(resolve(abs, '..'));
  }
  return name;
}

/** Read a context file relative to cwd and return its content, or '' on error. */
function readContextFile(path: string): string {
  try {
    return readFileSync(resolve(path), 'utf-8').trim();
  } catch {
    return '';
  }
}

export function registerSeriesCommands(program: Command, getClient: () => AutopodClient): void {
  const series = program.command('series').description('Manage series of pods');

  // ap series create <folder>
  series
    .command('create <folder>')
    .description('Create a series of pods from a folder of markdown briefs')
    .requiredOption('-p, --profile <name>', 'Profile to use for all pods')
    .option('-b, --base-branch <branch>', 'Base branch (default: profile default)')
    .option(
      '--pr-mode <mode>',
      'PR creation mode: single (one PR for full series), stacked (one PR per pod), none',
      'single',
    )
    .option('--series-name <name>', 'Override series name (default: derived from folder name)')
    .action(
      async (
        folder: string,
        opts: {
          profile: string;
          baseBranch?: string;
          prMode: string;
          seriesName?: string;
        },
      ) => {
        const client = getClient();
        const folderPath = resolve(folder);

        // Read brief files sorted by numeric prefix
        let files: string[];
        try {
          files = readdirSync(folderPath)
            .filter((f) => extname(f) === '.md' && f !== 'context.md')
            .sort((a, b) => numericPrefix(a) - numericPrefix(b));
        } catch {
          console.error(chalk.red(`Cannot read folder: ${folderPath}`));
          process.exit(1);
        }

        if (files.length === 0) {
          console.error(chalk.red('No .md brief files found in folder (excluding context.md)'));
          process.exit(1);
        }

        // Read shared context.md if present
        const contextMdPath = join(folderPath, 'context.md');
        let sharedContext = '';
        try {
          sharedContext = readFileSync(contextMdPath, 'utf-8').trim();
        } catch {
          // no context.md — that's fine
        }

        const seriesName = opts.seriesName ?? inferSeriesName(folderPath);
        const prMode = opts.prMode as 'single' | 'stacked' | 'none';

        const briefFiles = files.map((filename) => ({
          filename,
          content: readFileSync(join(folderPath, filename), 'utf-8'),
        }));
        const briefs = parseBriefs(briefFiles, sharedContext, readContextFile);

        console.log(
          chalk.cyan(`\nCreating series "${seriesName}" with ${briefs.length} pods...\n`),
        );

        const result = await withSpinner('Creating series...', () =>
          client.createSeries({
            seriesName,
            briefs,
            profile: opts.profile,
            baseBranch: opts.baseBranch,
            prMode,
          }),
        );

        console.log(chalk.green(`\nSeries created: ${result.seriesId}\n`));
        console.log(`  Name:    ${result.seriesName}`);
        console.log(`  PR mode: ${prMode}`);
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

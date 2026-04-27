import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { numericPrefix, parseBriefs } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';

/**
 * Resolve the spec layout for a folder argument. The user may point either
 * at the spec root (`specs/<feature>/`, containing `briefs/`) or at the
 * briefs folder itself (`specs/<feature>/briefs/`). Returns the resolved
 * spec root and briefs folder so the caller can read shared docs from the
 * root and brief files from the briefs folder.
 */
function resolveSpecLayout(folderArg: string): { specRoot: string; briefsDir: string } {
  const abs = resolve(folderArg);
  const folderName = basename(abs);

  // Case A: user pointed at `briefs/` — spec root is the parent.
  if (folderName === 'briefs') {
    return { specRoot: resolve(abs, '..'), briefsDir: abs };
  }

  // Case B: user pointed at the spec root — briefs/ is a subfolder.
  const briefsSubdir = join(abs, 'briefs');
  if (existsSync(briefsSubdir) && statSync(briefsSubdir).isDirectory()) {
    return { specRoot: abs, briefsDir: briefsSubdir };
  }

  // Case C: flat layout — same folder for both. Used by ad-hoc one-off briefs.
  return { specRoot: abs, briefsDir: abs };
}

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

export function registerSeriesCommands(program: Command, getClient: () => AutopodClient): void {
  const series = program.command('series').description('Manage series of pods');

  // ap series create <folder>
  series
    .command('create <folder>')
    .description(
      'Create a series of pods from a spec folder (containing purpose.md, design.md, and briefs/).',
    )
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
        const { specRoot, briefsDir } = resolveSpecLayout(folder);

        // Read brief files sorted by numeric prefix.
        let briefFilenames: string[];
        try {
          briefFilenames = readdirSync(briefsDir)
            .filter((f) => extname(f) === '.md')
            .sort((a, b) => numericPrefix(a) - numericPrefix(b));
        } catch {
          console.error(chalk.red(`Cannot read briefs folder: ${briefsDir}`));
          process.exit(1);
        }

        if (briefFilenames.length === 0) {
          console.error(chalk.red(`No .md brief files found in ${briefsDir}`));
          process.exit(1);
        }

        // Shared spec docs live at the spec root (parent of briefs/).
        const seriesDescription = readMaybe(specRoot, 'purpose.md');
        const seriesDesign = readMaybe(specRoot, 'design.md');

        const seriesName = opts.seriesName ?? inferSeriesName(specRoot);
        const prMode = opts.prMode as 'single' | 'stacked' | 'none';

        const briefFiles = briefFilenames.map((filename) => ({
          filename,
          content: readFileSync(join(briefsDir, filename), 'utf-8'),
        }));

        // `context_files` paths in brief frontmatter are resolved relative to
        // the spec root so a brief can pull in `decisions/...` or files at
        // the repo root via relative paths from there.
        const briefs = parseBriefs(briefFiles, (path) => readMaybe(specRoot, path));

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
            seriesDescription: seriesDescription || undefined,
            seriesDesign: seriesDesign || undefined,
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

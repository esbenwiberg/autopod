import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { AcDefinition } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';

interface BriefFrontmatter {
  title?: string;
  depends_on?: string[];
  context_files?: string[];
  handover_from?: string[];
  acceptance_criteria?: AcDefinition[];
}

/** Extract YAML frontmatter + body from a markdown file. */
function parseBriefFile(filePath: string): { frontmatter: BriefFrontmatter; body: string } {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1] ?? '') ?? {}) as BriefFrontmatter;
  return { frontmatter, body: (match[2] ?? '').trim() };
}

/** Infer series name from folder path: parent dir if folder is named 'briefs', else folder name. */
function inferSeriesName(folderPath: string): string {
  const abs = resolve(folderPath);
  const name = basename(abs);
  if (name === 'briefs' || name === 'briefs/') {
    return basename(resolve(abs, '..'));
  }
  return name;
}

/** Numeric prefix from filename, e.g. "01-types.md" → 1. Returns Infinity if none. */
function numericPrefix(filename: string): number {
  const m = filename.match(/^(\d+)/);
  return m ? Number.parseInt(m[1] ?? '0', 10) : Number.POSITIVE_INFINITY;
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

        // Single parse pass — avoids re-reading files during dependency resolution
        type Parsed = { frontmatter: BriefFrontmatter; body: string; title: string };
        const allParsed = new Map<string, Parsed>();
        for (const file of files) {
          const { frontmatter, body } = parseBriefFile(join(folderPath, file));
          allParsed.set(file, {
            frontmatter,
            body,
            title: frontmatter.title ?? file.replace(/^\d+-/, '').replace(/\.md$/, ''),
          });
        }

        const briefs = files.map((file, i) => {
          const { frontmatter, body, title } = allParsed.get(file) ?? {
            frontmatter: {} as BriefFrontmatter,
            body: '',
            title: file,
          };

          // Prepend shared context then any explicit context_files
          const contextParts: string[] = [];
          if (sharedContext && !frontmatter.context_files) {
            contextParts.push(sharedContext);
          }
          for (const cf of frontmatter.context_files ?? []) {
            const cfContent = readContextFile(cf);
            if (cfContent) contextParts.push(cfContent);
          }
          const task =
            contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\n---\n\n${body}` : body;

          // Resolve depends_on to titles using the pre-parsed map (no re-reads)
          const dependsOn = (frontmatter.depends_on ?? []).map((dep) => {
            const depFile = files.find((f) => f.startsWith(dep) || f === `${dep}.md`);
            return depFile ? (allParsed.get(depFile)?.title ?? dep) : dep;
          });

          // If no explicit depends_on, infer from numeric prefix (each brief depends on the previous)
          const inferredDepsOn: string[] = (() => {
            if (dependsOn.length > 0 || i === 0) return dependsOn;
            const prevFile = files[i - 1];
            const prevTitle = prevFile ? (allParsed.get(prevFile)?.title ?? '') : '';
            return prevTitle ? [prevTitle] : dependsOn;
          })();

          return {
            title,
            task,
            dependsOn: inferredDepsOn,
            acceptanceCriteria: frontmatter.acceptance_criteria,
          };
        });

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

import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';

export function registerResearchCommands(program: Command, getClient: () => AutopodClient): void {
  program
    .command('research <profile> <task>')
    .description('Run a research agent — produces artifacts instead of a PR')
    .option(
      '--repo <url>',
      'Read-only reference repo to clone into the container (repeatable)',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option('--repo-pat <token>', 'PAT shared across all reference repos (for private repos)')
    .action(async (profile: string, task: string, opts: { repo: string[]; repoPat?: string }) => {
      const client = getClient();
      const referenceRepos = opts.repo.length ? opts.repo.map((url) => ({ url })) : undefined;

      const pod = await withSpinner('Creating research pod…', () =>
        client.createSession({
          profileName: profile,
          task,
          outputMode: 'artifact',
          referenceRepos,
          referenceRepoPat: opts.repoPat,
        }),
      );

      console.log(chalk.green(`Research pod ${chalk.bold(pod.id)} created.`));
      console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
      console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
      if (pod.referenceRepos?.length) {
        console.log(
          `${chalk.bold('Repos:')}    ${pod.referenceRepos.map((r: { mountPath: string }) => r.mountPath).join(', ')}`,
        );
      }
      console.log();
      console.log(chalk.dim(`Watch progress:  ap logs ${pod.id.slice(0, 8)}`));
      console.log(chalk.dim('Browse artifacts: open desktop app → pod → Markdown tab'));
    });
}

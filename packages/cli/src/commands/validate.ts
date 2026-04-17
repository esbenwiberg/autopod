import chalk from 'chalk';
import type { Command } from 'commander';
import open from 'open';
import type { AutopodClient } from '../api/client.js';
import { withSpinner } from '../output/spinner.js';
import { resolvePodId } from '../utils/id-resolver.js';

export function registerValidateCommands(program: Command, getClient: () => AutopodClient): void {
  // ap validate
  program
    .command('validate <id>')
    .description('Trigger validation for a pod')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Triggering validation...', () => client.triggerValidation(resolvedId));
      console.log(chalk.green('Validation triggered.'));
      console.log(chalk.dim(`Check results: ap status ${resolvedId.slice(0, 8)}`));
    });

  // ap open
  program
    .command('open <id>')
    .description('Open the pod preview URL in browser')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      if (!pod.previewUrl) {
        console.log(chalk.yellow('No preview URL available for this pod.'));
        console.log(chalk.dim('The pod may not be running or may not have a web server.'));
        return;
      }

      console.log(chalk.dim(`Opening ${pod.previewUrl}...`));
      await open(pod.previewUrl);
    });

  // ap diff
  program
    .command('diff <id>')
    .description('Show the diff for a pod')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      if (pod.lastValidationResult?.taskReview?.diff) {
        process.stdout.write(pod.lastValidationResult.taskReview.diff);
      } else {
        console.log(chalk.dim('No diff available. The pod may not have been validated yet.'));
      }
    });
}

import chalk from 'chalk';
import type { Command } from 'commander';
import open from 'open';
import type { AutopodClient } from '../api/client.js';
import { withSpinner } from '../output/spinner.js';
import { resolveSessionId } from '../utils/id-resolver.js';

export function registerValidateCommands(program: Command, getClient: () => AutopodClient): void {
  // ap validate
  program
    .command('validate <id>')
    .description('Trigger validation for a session')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Triggering validation...', () => client.triggerValidation(resolvedId));
      console.log(chalk.green('Validation triggered.'));
      console.log(chalk.dim(`Check results: ap status ${resolvedId.slice(0, 8)}`));
    });

  // ap open
  program
    .command('open <id>')
    .description('Open the session preview URL in browser')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      const session = await client.getSession(resolvedId);

      if (!session.previewUrl) {
        console.log(chalk.yellow('No preview URL available for this session.'));
        console.log(chalk.dim('The session may not be running or may not have a web server.'));
        return;
      }

      console.log(chalk.dim(`Opening ${session.previewUrl}...`));
      await open(session.previewUrl);
    });

  // ap diff
  program
    .command('diff <id>')
    .description('Show the diff for a session')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      const session = await client.getSession(resolvedId);

      if (session.lastValidationResult?.taskReview?.diff) {
        process.stdout.write(session.lastValidationResult.taskReview.diff);
      } else {
        console.log(chalk.dim('No diff available. The session may not have been validated yet.'));
      }
    });
}

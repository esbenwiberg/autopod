import { type DiffResponse, parseDiff, statsForFiles } from '@autopod/shared';
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
    .option('--json', 'Output diff files and stats as JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      let result: DiffResponse;
      try {
        result = await client.getPodDiff(resolvedId);
      } catch (error) {
        // Older daemons may not serve the diff route. Retain the stored review
        // as a fallback, but do not turn an unavailable diff into an empty one.
        const pod = await client.getSession(resolvedId);
        const diff = pod.lastValidationResult?.taskReview?.diff;
        if (!diff) throw error;

        if (opts.json) {
          const files = parseDiff(diff);
          console.log(
            JSON.stringify({ files, stats: statsForFiles(files), source: 'task-review' }, null, 2),
          );
        } else {
          process.stdout.write(diff);
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.files.length > 0) {
        process.stdout.write(result.files.map((file) => file.diff).join(''));
      } else {
        console.log(chalk.dim('No changes in the pod diff.'));
      }
    });
}

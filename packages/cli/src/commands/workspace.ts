import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';
import { resolveSessionId } from '../utils/id-resolver.js';

export function registerWorkspaceCommands(program: Command, getClient: () => AutopodClient): void {
  // ap workspace <profile> [description]
  program
    .command('workspace <profile> [description]')
    .description('Create a workspace pod — an interactive container with no agent')
    .option('-b, --branch <name>', 'Explicit branch name (for handoff to worker)')
    .action(async (profile: string, description: string | undefined, opts: { branch?: string }) => {
      const client = getClient();
      const session = await withSpinner('Creating workspace session...', () =>
        client.createSession({
          profileName: profile,
          task: description ?? 'Workspace session',
          outputMode: 'workspace',
          branch: opts.branch,
        }),
      );

      console.log(chalk.green(`Workspace ${chalk.bold(session.id)} created.`));
      console.log(`${chalk.bold('Profile:')}  ${session.profileName}`);
      console.log(`${chalk.bold('Status:')}   ${formatStatus(session.status)}`);
      console.log(`${chalk.bold('Branch:')}   ${session.branch}`);
      console.log();
      console.log(chalk.dim(`Enter the container:  ap attach ${session.id.slice(0, 8)}`));
      console.log(
        chalk.dim(`Hand off to worker:   ap run ${profile} <task> --base-branch ${session.branch}`),
      );
    });

  // ap attach <id>
  program
    .command('attach <id>')
    .description('Attach to a running workspace pod via docker exec')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      const session = await client.getSession(resolvedId);

      if (session.outputMode !== 'workspace') {
        console.error(chalk.red(`Session ${resolvedId} is not a workspace session.`));
        process.exit(1);
      }

      if (session.status !== 'running') {
        console.error(
          chalk.red(
            `Session ${resolvedId} is ${session.status} — can only attach to running sessions.`,
          ),
        );
        process.exit(1);
      }

      const containerName = `autopod-${session.id}`;
      console.log(chalk.dim(`Attaching to ${containerName}…`));
      console.log(chalk.dim('Type "exit" to detach and complete the session.\n'));

      // Try bash first, fall back to sh
      let result = spawnSync('docker', ['exec', '-it', containerName, 'bash'], {
        stdio: 'inherit',
      });

      if (result.error) {
        console.error(chalk.red('docker CLI not found on PATH'));
        process.exit(1);
      }

      // Non-zero exit could mean bash not available — retry with sh
      if (result.status !== 0) {
        result = spawnSync('docker', ['exec', '-it', containerName, 'sh'], {
          stdio: 'inherit',
        });
      }

      // Complete the session (daemon pushes branch)
      console.log();
      const completion = await withSpinner('Completing workspace session...', () =>
        client.completeSession(resolvedId),
      );

      if (completion.pushError) {
        console.log(
          chalk.yellow(`Session complete, but branch push failed: ${completion.pushError}`),
        );
        console.log(chalk.dim('You can push manually from the worktree.'));
      } else {
        console.log(chalk.green('Session complete. Branch pushed to origin.'));
      }
    });
}

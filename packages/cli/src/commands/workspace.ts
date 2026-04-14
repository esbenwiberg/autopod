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
    .option(
      '--pim-group <spec>',
      'PIM group to activate: <groupId> or <groupId:displayName> (repeatable)',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .action(
      async (
        profile: string,
        description: string | undefined,
        opts: { branch?: string; pimGroup?: string[] },
      ) => {
        const client = getClient();
        const pimGroups = opts.pimGroup?.length
          ? opts.pimGroup.map((spec) => {
              const colonIdx = spec.indexOf(':');
              if (colonIdx === -1) return { groupId: spec };
              return {
                groupId: spec.slice(0, colonIdx),
                displayName: spec.slice(colonIdx + 1),
              };
            })
          : undefined;

        const session = await withSpinner('Creating workspace session...', () =>
          client.createSession({
            profileName: profile,
            task: description ?? 'Workspace session',
            outputMode: 'workspace',
            branch: opts.branch,
            pimGroups,
          }),
        );

        console.log(chalk.green(`Workspace ${chalk.bold(session.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${session.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(session.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${session.branch}`);
        console.log();
        console.log(chalk.dim(`Enter the container:  ap attach ${session.id.slice(0, 8)}`));
        console.log(
          chalk.dim(
            `Hand off to worker:   ap run ${profile} <task> --base-branch ${session.branch}`,
          ),
        );
      },
    );

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
      console.log(chalk.dim('Type "exit" to detach. Run "ap complete <id>" when done.\n'));

      // Use tmux if available — reattaches to an existing session so reconnects
      // pick up right where you left off. Falls back to bash/sh if tmux isn't installed.
      const tmuxCmd =
        'command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s main || exec /bin/bash -l';

      const result = spawnSync(
        'docker',
        ['exec', '-it', containerName, '/bin/sh', '-c', tmuxCmd],
        { stdio: 'inherit' },
      );

      if (result.error) {
        console.error(chalk.red('docker CLI not found on PATH'));
        process.exit(1);
      }

      console.log();

      // Non-zero exit may mean the container stopped unexpectedly
      if (result.status !== 0) {
        try {
          const refreshed = await client.getSession(resolvedId);
          if (refreshed.status !== 'running') {
            console.log(chalk.yellow('Container stopped unexpectedly.'));
            console.log(
              chalk.dim(
                `Run "ap complete ${resolvedId.slice(0, 8)}" to recover changes and push branch.`,
              ),
            );
            return;
          }
        } catch {
          // Couldn't refresh — fall through to normal detach message
        }
      }

      console.log(chalk.dim('Detached. Session is still running.'));
      console.log(chalk.dim(`Re-attach:  ap attach ${resolvedId.slice(0, 8)}`));
      console.log(chalk.dim(`Complete:   ap complete ${resolvedId.slice(0, 8)}`));
    });

  // ap complete <id>
  program
    .command('complete <id>')
    .description('Complete a workspace pod — sync changes and push branch to origin')
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
            `Session ${resolvedId} is ${session.status} — can only complete running sessions.`,
          ),
        );
        process.exit(1);
      }

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

  // ap inject <id> github|ado
  program
    .command('inject <id> <service>')
    .description('Inject provider credentials into a running container (github or ado)')
    .action(async (id: string, service: string) => {
      if (service !== 'github' && service !== 'ado') {
        console.error(chalk.red('service must be "github" or "ado"'));
        process.exit(1);
      }

      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);

      // Wait up to 60s for the container to reach 'running' before injecting
      const WAIT_TIMEOUT_MS = 60_000;
      const POLL_INTERVAL_MS = 1_500;
      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      await withSpinner(`Injecting ${service} credentials…`, async () => {
        while (true) {
          const session = await client.getSession(resolvedId);
          if (session.status === 'running') break;

          const terminalStates = ['complete', 'killed', 'failed'];
          if (terminalStates.includes(session.status)) {
            const err = new Error(
              `Session ${resolvedId.slice(0, 8)} is ${session.status} — cannot inject credentials.`,
            );
            throw err;
          }

          if (Date.now() >= deadline) {
            throw new Error(
              `Session ${resolvedId.slice(0, 8)} is still ${session.status} after ${WAIT_TIMEOUT_MS / 1000}s — container may have failed to start.`,
            );
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        await client.injectCredential(resolvedId, service as 'github' | 'ado');
      });

      console.log(
        chalk.green(
          `Done. ${service} credentials injected into session ${resolvedId.slice(0, 8)}.`,
        ),
      );
      console.log(
        chalk.dim(
          'git and CLI tools are now authenticated. Credentials are gone when the container stops.',
        ),
      );
    });
}

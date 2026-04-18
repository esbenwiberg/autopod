import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';
import { resolvePodId } from '../utils/id-resolver.js';

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

        const pod = await withSpinner('Creating workspace pod...', () =>
          client.createSession({
            profileName: profile,
            task: description ?? 'Workspace pod',
            outputMode: 'workspace',
            branch: opts.branch,
            pimGroups,
          }),
        );

        console.log(chalk.green(`Workspace ${chalk.bold(pod.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${pod.branch}`);
        console.log();
        console.log(chalk.dim(`Enter the container:  ap attach ${pod.id.slice(0, 8)}`));
        console.log(
          chalk.dim(`Hand off to worker:   ap run ${profile} <task> --base-branch ${pod.branch}`),
        );
      },
    );

  // ap attach <id>
  program
    .command('attach <id>')
    .description('Attach to a running workspace pod via docker exec')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      if (pod.options?.agentMode !== 'interactive' && pod.outputMode !== 'workspace') {
        console.error(chalk.red(`Pod ${resolvedId} is not an interactive pod.`));
        process.exit(1);
      }

      if (pod.status !== 'running') {
        console.error(
          chalk.red(`Pod ${resolvedId} is ${pod.status} — can only attach to running pods.`),
        );
        process.exit(1);
      }

      const containerName = `autopod-${pod.id}`;
      console.log(chalk.dim(`Attaching to ${containerName}…`));
      console.log(chalk.dim('Type "exit" to detach. Run "ap complete <id>" when done.\n'));

      const result = spawnSync('docker', ['exec', '-it', containerName, '/bin/bash', '-l'], {
        stdio: 'inherit',
      });

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

      console.log(chalk.dim('Detached. Pod is still running.'));
      console.log(chalk.dim(`Re-attach:  ap attach ${resolvedId.slice(0, 8)}`));
      console.log(chalk.dim(`Complete:   ap complete ${resolvedId.slice(0, 8)}`));
    });

  // ap complete <id>
  //
  // With no flag: push the branch and transition to `complete`.
  // With --pr / --artifact / --none: promote the pod in-place to an
  // agent-driven run on the same ID (branch, events, token budget preserved).
  program
    .command('complete <id>')
    .description('Complete an interactive pod — push branch, or hand off to the agent')
    .option('--pr', 'Hand off to the agent and open a PR when it finishes')
    .option('--artifact', 'Hand off to the agent in artifact mode (no PR)')
    .option('--none', 'Hand off to the agent ephemerally (no push)')
    .action(async (id: string, opts: { pr?: boolean; artifact?: boolean; none?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      if (pod.options?.agentMode !== 'interactive' && pod.outputMode !== 'workspace') {
        console.error(chalk.red(`Pod ${resolvedId} is not an interactive pod.`));
        process.exit(1);
      }

      if (pod.status !== 'running') {
        console.error(
          chalk.red(`Pod ${resolvedId} is ${pod.status} — can only complete running pods.`),
        );
        process.exit(1);
      }

      const promoteFlags = [opts.pr, opts.artifact, opts.none].filter(Boolean).length;
      if (promoteFlags > 1) {
        console.error(chalk.red('Choose at most one of --pr, --artifact, --none'));
        process.exit(1);
      }
      const promoteTo = opts.pr
        ? ('pr' as const)
        : opts.artifact
          ? ('artifact' as const)
          : opts.none
            ? ('none' as const)
            : undefined;

      console.log();
      const completion = await withSpinner(
        promoteTo ? `Promoting pod to ${promoteTo}…` : 'Completing pod…',
        () => client.completeSession(resolvedId, promoteTo ? { promoteTo } : undefined),
      );

      if (completion.promotedTo) {
        console.log(
          chalk.green(`Pod handed off. Agent will take over in ${completion.promotedTo} mode.`),
        );
        console.log(chalk.dim(`Track progress: ap status ${resolvedId.slice(0, 8)}`));
        return;
      }

      if (completion.pushError) {
        console.log(chalk.yellow(`Pod complete, but branch push failed: ${completion.pushError}`));
        console.log(chalk.dim('You can push manually from the worktree.'));
      } else {
        console.log(chalk.green('Pod complete. Branch pushed to origin.'));
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
      const resolvedId = await resolvePodId(client, id);

      // Wait up to 60s for the container to reach 'running' before injecting
      const WAIT_TIMEOUT_MS = 60_000;
      const POLL_INTERVAL_MS = 1_500;
      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      await withSpinner(`Injecting ${service} credentials…`, async () => {
        while (true) {
          const pod = await client.getSession(resolvedId);
          if (pod.status === 'running') break;

          const terminalStates = ['complete', 'killed', 'failed'];
          if (terminalStates.includes(pod.status)) {
            const err = new Error(
              `Pod ${resolvedId.slice(0, 8)} is ${pod.status} — cannot inject credentials.`,
            );
            throw err;
          }

          if (Date.now() >= deadline) {
            throw new Error(
              `Pod ${resolvedId.slice(0, 8)} is still ${pod.status} after ${WAIT_TIMEOUT_MS / 1000}s — container may have failed to start.`,
            );
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        await client.injectCredential(resolvedId, service as 'github' | 'ado');
      });

      console.log(
        chalk.green(`Done. ${service} credentials injected into pod ${resolvedId.slice(0, 8)}.`),
      );
      console.log(
        chalk.dim(
          'git and CLI tools are now authenticated. Credentials are gone when the container stops.',
        ),
      );
    });
}

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EffectiveLaunchConfig, LaunchRequest } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { saveLaunchReceipt } from '../config/launch-store.js';
import { type LaunchFlags, buildLaunchRequest } from './launch-request.js';
import { type LaunchTaskFlags, readLaunchTask } from './launch-task.js';

function positive(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error('Allocation must be a positive number.');
  return number;
}
function summarize(config: EffectiveLaunchConfig): string {
  const profile =
    config.revisions.find((item) => item.id === config.profileId)?.name ?? config.profileId;
  return [
    `Repository: ${config.repository?.config.remote ?? 'Empty workspace'}`,
    `Profile: ${profile}`,
    `AI: ${config.ai.main.runtime} / ${config.ai.main.model}`,
    `Execution: ${config.execution.target} / ${config.resolvedExecution.main.memoryGb} GB`,
    `Intent: ${config.intent}`,
    `Configuration: ${config.digest}`,
  ].join('\n');
}
export function registerLaunchCommand(
  program: Command,
  getClient: () => AutopodClient,
  saveRequest = saveLaunchReceipt,
  mode: { name: string; output?: 'artifact'; analysis?: 'history' | 'memory' } = { name: 'run' },
): void {
  const command = program
    .command(`${mode.name} [legacy...]`)
    .description('Launch a repository with a reusable profile and optional preset selections')
    .option('--repo <name-or-id>', 'Repository name or ID')
    .option('--from-pod <id>', 'Start with an existing pod configuration')
    .option(
      '--source-config <original|current|worker>',
      'Frozen configuration, current presets, or the frozen workspace worker',
      'original',
    )
    .option('--empty-workspace', 'Create a workspace without a repository')
    .option('--repository-setup <name-or-id>', 'Named project setup')
    .option('--profile <name-or-id>', 'Profile; otherwise use the repository usual profile')
    .option('--task <text>', 'Task or objective; uses the workflow intent by default')
    .option('--file <path>', 'Read the task from a UTF-8 file')
    .option('--spec <folder>', 'Read a brief and contract, with runtime context files')
    .option('--include-specs', 'Commit the spec files on the new pod branch')
    .option('--no-spec-context', 'Omit spec files from runtime context')
    .option('--branch <name>', 'Explicit branch name for this work')
    .option('--start-branch <ref>', 'Start from this branch or revision')
    .option('--base-branch <ref>', 'Target this base branch')
    .option('--goal <objective>', 'Use a supported native Goal workflow')
    .option('--intent <task|goal>', 'Explicitly override workflow intent')
    .option('--config <file>', 'Full shared LaunchRequest JSON file')
    .option('--override-config', 'Let explicit flags replace corresponding file settings')
    .option('--request-id <id>', 'Stable launch key; reuse it after a lost response')
    .option('--preview', 'Resolve and display effective configuration without launching')
    .option('--json', 'Output the full preview or created pod as JSON');
  addLaunchPresetOptions(command);
  if (mode.analysis === 'history') {
    command
      .option('--since <ISO-date>', 'History beginning at this ISO timestamp')
      .option('--failures', 'Export only failed, killed or review-required pods')
      .option('--limit <count>', 'History export limit, at most 1000', positive)
      .option('--all-repositories', 'Explicitly include history from every repository');
  }
  command.action(
    async (
      legacy: string[],
      opts: LaunchFlags &
        LaunchTaskFlags & {
          config?: string;
          preview?: boolean;
          json?: boolean;
          fromPod?: string;
          sourceConfig: string;
          since?: string;
          failures?: boolean;
          limit?: number;
          allRepositories?: boolean;
        },
    ) => {
      if (legacy.length)
        throw new Error(
          `Profile-first positional launches were removed. Use: ap ${mode.name} --repo <repository> --profile <profile> --task "Task"`,
        );
      const client = getClient();
      const taskInput = readLaunchTask(opts);
      if (taskInput.requiredSidecarIds?.length) {
        if (opts.sidecars === false)
          throw new Error('The spec requires sidecars; --no-sidecars conflicts with it.');
        opts.sidecar = [...new Set([...(opts.sidecar ?? []), ...taskInput.requiredSidecarIds])];
      }
      if (taskInput.task !== undefined) opts.task = taskInput.task;
      if (opts.config && Object.keys(taskInput.work).length && !opts.overrideConfig)
        throw new Error(
          'Work flags conflict with --config. Use --override-config for a new request.',
        );
      if (!opts.fromPod && opts.sourceConfig !== 'original')
        throw new Error('--source-config requires --from-pod.');
      let file: unknown = opts.config ? JSON.parse(readFileSync(opts.config, 'utf8')) : undefined;
      if (opts.fromPod) {
        if (opts.config)
          throw new Error(
            'Choose --from-pod or --config. A saved request already contains its source.',
          );
        if (!['original', 'current', 'worker'].includes(opts.sourceConfig))
          throw new Error('--source-config must be original, current or worker.');
        const source = await client.getPodLaunchConfiguration(opts.fromPod);
        file = {
          ...(source.repository
            ? {
                repositoryId: source.repository.id,
                repositorySetupId: source.repository.setup.id,
              }
            : { emptyWorkspace: true }),
          profileId: source.profileId,
          task: opts.goal ?? opts.task ?? source.task,
          source: {
            podId: opts.fromPod,
            digest: source.digest,
            configuration: opts.sourceConfig,
          },
        };
      }
      const flags =
        mode.analysis && !file && !opts.task && !opts.goal
          ? {
              ...opts,
              task:
                mode.analysis === 'history'
                  ? 'Analyze the exported pod history in /history.'
                  : 'Review /history/memories.md against this repository and draft a prioritized fix plan.',
            }
          : opts;
      const request = await buildLaunchRequest(
        opts.fromPod ? { ...flags, overrideConfig: true } : flags,
        (kind) => client.listConfigurations(kind),
        file,
      );
      if (Object.keys(taskInput.work).length) {
        request.work = { ...request.work, ...taskInput.work };
        if (opts.config) {
          Reflect.deleteProperty(request, 'expectedDigest');
          if (!opts.requestId) Reflect.deleteProperty(request, 'requestId');
        }
      }
      if (
        mode.analysis &&
        request.expectedDigest &&
        [opts.since, opts.failures, opts.limit, opts.allRepositories].some(
          (value) => value !== undefined,
        )
      )
        throw new Error(
          'Analysis flags cannot change a saved retry. Replay with ap run --config, or create a new analysis request.',
        );
      if (mode.analysis && !request.expectedDigest) {
        if (request.source && request.source.configuration !== 'current')
          throw new Error('Use --source-config current to configure a new analysis workspace.');
        request.intent = 'task';
        request.work = {
          ...request.work,
          analysis:
            mode.analysis === 'memory'
              ? { kind: 'memory' }
              : {
                  kind: 'history',
                  scope: opts.allRepositories ? 'all' : 'repository',
                  since: opts.since,
                  limit: opts.limit ?? 100,
                  failuresOnly: opts.failures ?? false,
                },
        };
        request.overrides = {
          ...request.overrides,
          workflow: {
            ...request.overrides?.workflow,
            agentMode: 'interactive',
            promotable: false,
            output: 'emptyWorkspace' in request ? 'artifact' : 'branch',
            completion: 'approval',
            validationPhases: [],
            advisoryBrowserQaEnabled: false,
          },
        };
      }
      if (
        mode.output &&
        request.source &&
        request.source.configuration !== 'current' &&
        request.expectedDigest
      )
        throw new Error('Replay this saved frozen request with ap run --config.');
      if (
        mode.output &&
        (!request.source || request.source.configuration === 'current') &&
        request.overrides?.workflow?.output !== mode.output
      ) {
        if (request.expectedDigest)
          throw new Error(
            'The saved request is for a different output. Replay it with ap run --config, or preview a new research request.',
          );
        request.overrides = {
          ...request.overrides,
          workflow: { ...request.overrides?.workflow, output: mode.output },
        };
      }
      // An exact saved retry reaches admission before mutable preset/discovery reads.
      const effective =
        opts.preview || !request.expectedDigest ? await client.resolveLaunch(request) : undefined;
      if (mode.output && effective && effective.workflow.output !== mode.output)
        throw new Error(
          'The frozen source does not use artifact output. Choose --source-config current for research.',
        );
      if (opts.preview) {
        if (!effective) throw new Error('Launch preview is unavailable.');
        console.log(opts.json ? JSON.stringify(effective, null, 2) : summarize(effective));
        return;
      }
      const admitted: LaunchRequest = {
        ...request,
        expectedDigest: request.expectedDigest ?? effective?.digest,
        requestId: request.requestId ?? randomUUID(),
      };
      const receipt = saveRequest(admitted);
      console.error(
        `Launch request saved: ${receipt}\nRetry the same request with: ap run --config ${JSON.stringify(receipt)}`,
      );
      const pod = await client.launchPod(admitted);
      if (opts.json) console.log(JSON.stringify(pod, null, 2));
      else
        console.log(
          `${effective ? `${summarize(effective)}\n` : ''}${chalk.green(`Pod ${pod.id} created.`)}\nTrack progress: ap status ${pod.id}`,
        );
    },
  );
}

/** Shared preset and allocation flags for worker and interactive launch commands. */
export function addLaunchPresetOptions(command: Command): Command {
  return command
    .option(
      '--reference <repository=ref>',
      'Read-only snapshot of an enrolled repository at this ref; repeat for multiple repositories',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--no-references', 'Clear reference repositories')
    .option('--environment <name-or-id>', 'Select an environment preset')
    .option('--ai <name-or-id>', 'Select the complete main/reviewer AI preset')
    .option('--workflow <name-or-id>', 'Select a workflow preset')
    .option('--github-access <name-or-id>', 'Select GitHub access rules')
    .option('--no-github-access', 'Clear GitHub agent access')
    .option(
      '--tool-pack <name-or-id>',
      'Select a tool pack; repeat for multiple packs',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--no-tool-packs', 'Clear all tool packs')
    .option(
      '--sidecar <instance-id>',
      'Require a configured sidecar instance; repeat for multiple instances',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--no-sidecars', 'Clear explicitly required sidecars; environment defaults still apply')
    .option('--execution <local|sandbox>', 'Choose Docker (local) or hosted sandbox')
    .option('--memory-gb <amount>', 'Main container memory in GB', positive)
    .option('--cpus <amount>', 'Main container CPU allocation where supported', positive);
}

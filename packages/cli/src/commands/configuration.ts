import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  type ConfigurationKind,
  type LaunchProfile,
  configurationPayloadSchemas,
  deploymentRequestSchema,
  issueWatcherBindingSchema,
} from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { configurationId } from './launch-request.js';

function revision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error('Revision must be a positive integer.');
  return parsed;
}
function jsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function output(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export async function selectProfilePresets(
  client: AutopodClient,
  ask: (prompt: string) => Promise<string>,
): Promise<LaunchProfile> {
  async function select(
    kind: ConfigurationKind,
    optional = false,
    multiple = false,
  ): Promise<string[]> {
    const items = (await client.listConfigurations(kind)).filter((item) => !item.archived);
    if (!items.length && !optional) throw new Error(`Create an ${kind} preset first.`);
    if (!items.length) return [];
    console.log(
      `\n${kind}\n${items.map((item, index) => `${index + 1}. ${item.name}`).join('\n')}`,
    );
    while (true) {
      const answer = (
        await ask(
          `${multiple ? 'Select numbers separated by commas' : 'Select a number'}${optional ? ' (Enter for none)' : ''}: `,
        )
      ).trim();
      if (!answer && optional) return [];
      const positions = answer.split(',').map((value) => Number(value.trim()) - 1);
      if (
        (!multiple && positions.length !== 1) ||
        positions.some((index) => !Number.isInteger(index) || !items[index]) ||
        new Set(positions).size !== positions.length
      ) {
        console.error('Select one of the listed numbers.');
        continue;
      }
      return positions.map((index) => items[index]!.id);
    }
  }
  const environmentId = (await select('environment'))[0];
  const aiId = (await select('ai'))[0];
  const workflowId = (await select('workflow'))[0];
  const githubAccessId = (await select('githubAccess', true))[0] ?? null;
  const toolPackIds = await select('toolPack', true, true);
  return configurationPayloadSchemas.profile.parse({
    environmentId,
    aiId,
    workflowId,
    githubAccessId,
    toolPackIds,
  });
}

function registerEntityCommands(
  command: Command,
  kind: ConfigurationKind,
  getClient: () => AutopodClient,
): void {
  command
    .command('list')
    .alias('ls')
    .option('--json', 'Full configuration JSON')
    .action(async (opts: { json?: boolean }) => {
      const entries = await getClient().listConfigurations(kind);
      if (opts.json) output(entries);
      else
        for (const item of entries)
          console.log(
            `${item.id}\t${item.name}\trevision ${item.revision}${item.archived ? '\tarchived' : ''}`,
          );
    });
  command
    .command('show <name-or-id>')
    .option('--json', 'Full configuration JSON (the default)')
    .option('--payload', 'Only the editable payload')
    .option('--output <file>', 'Write JSON to a new file')
    .action(async (name: string, opts: { payload?: boolean; output?: string }) => {
      const client = getClient();
      const id = await configurationId(kind, name, (type) => client.listConfigurations(type));
      const entry = await client.getConfiguration(kind, id);
      const value = opts.payload ? entry.payload : entry;
      if (opts.output)
        writeFileSync(opts.output, `${JSON.stringify(value, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      else output(value);
    });
  command
    .command('create')
    .requiredOption('--name <name>')
    .option('--file <file>', 'Complete preset payload JSON')
    .action(async (opts: { name: string; file?: string }) => {
      const client = getClient();
      let payload: unknown;
      if (opts.file) payload = jsonFile(opts.file);
      else if (kind === 'profile' && process.stdin.isTTY) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          payload = await selectProfilePresets(client, (question) => prompt.question(question));
        } finally {
          prompt.close();
        }
      } else
        throw new Error(
          'Supply --file with the complete JSON payload. Profile creation also supports an interactive preset picker.',
        );
      output(
        await client.writeConfiguration(kind, {
          name: opts.name,
          payload: configurationPayloadSchemas[kind].parse(payload),
        }),
      );
    });
  command
    .command('update <name-or-id>')
    .requiredOption('--file <file>', 'Complete replacement payload JSON')
    .requiredOption(
      '--expected-revision <number>',
      'Revision of the configuration you edited',
      revision,
    )
    .option('--name <name>', 'Rename while preserving the ID')
    .action(
      async (name: string, opts: { file: string; expectedRevision: number; name?: string }) => {
        const client = getClient();
        const id = await configurationId(kind, name, (type) => client.listConfigurations(type));
        const entry = await client.getConfiguration(kind, id);
        output(
          await client.writeConfiguration(kind, {
            id,
            name: opts.name ?? entry.name,
            payload: configurationPayloadSchemas[kind].parse(jsonFile(opts.file)),
            expectedRevision: opts.expectedRevision,
          }),
        );
      },
    );
  command
    .command('archive <name-or-id>')
    .requiredOption('--expected-revision <number>', 'Revision to archive', revision)
    .action(async (name: string, opts: { expectedRevision: number }) => {
      const client = getClient();
      const id = await configurationId(kind, name, (type) => client.listConfigurations(type));
      await client.archiveConfiguration(kind, id, opts.expectedRevision);
      console.log(`Archived ${kind} ${id}.`);
    });
}
export function registerConfigurationCommands(
  program: Command,
  getClient: () => AutopodClient,
): void {
  const deployment = program
    .command('deployment')
    .description('Request and review deployment of the published default branch');
  deployment
    .command('reconcile <run-id>')
    .requiredOption('--digest <digest>', 'Exact deployment approval digest')
    .requiredOption('--outcome <outcome>', 'Observed destination outcome: deployed or not-deployed')
    .requiredOption('--note <note>', 'What you checked at the destination')
    .action(async (id: string, opts: { digest: string; outcome: string; note: string }) => {
      if (
        !/^[a-f0-9]{64}$/.test(opts.digest) ||
        !['deployed', 'not-deployed'].includes(opts.outcome) ||
        !opts.note.trim()
      )
        throw new Error(
          'Provide the exact digest, observed outcome, and a nonempty verification note.',
        );
      output(
        await getClient().reconcileDeployment(
          id,
          opts.digest,
          opts.outcome as 'deployed' | 'not-deployed',
          opts.note,
        ),
      );
    });
  deployment.command('list').action(async () => output(await getClient().listDeployments()));
  deployment
    .command('request <pod-id> <script-path>')
    .requiredOption('--key <key>', 'Stable operation key; reuse on retries')
    .option('--args-json <json>', 'Script arguments as a JSON array', '[]')
    .action(async (podId: string, scriptPath: string, opts: { key: string; argsJson: string }) =>
      output(
        await getClient().requestDeployment(
          podId,
          deploymentRequestSchema.parse({
            operationKey: opts.key,
            scriptPath,
            args: JSON.parse(opts.argsJson),
          }),
        ),
      ),
    );
  deployment
    .command('status <run-id>')
    .action(async (id: string) => output(await getClient().getDeployment(id)));
  deployment
    .command('review <run-id>')
    .action(async (id: string) => output(await getClient().getDeployment(id, true)));
  for (const decision of ['approve', 'deny'] as const)
    deployment
      .command(`${decision} <run-id>`)
      .requiredOption('--digest <digest>', 'Exact approval digest shown by review')
      .action(async (id: string, opts: { digest: string }) => {
        if (!/^[a-f0-9]{64}$/.test(opts.digest))
          throw new Error('Use the exact 64-character digest shown by deployment review.');
        output(await getClient().decideDeployment(id, opts.digest, decision));
      });
  registerEntityCommands(
    program.command('repository').description('Manage repositories and their named project setups'),
    'repository',
    getClient,
  );
  registerEntityCommands(
    program.command('profile').description('Choose reusable presets and execution defaults'),
    'profile',
    getClient,
  );
  const presets = program.command('preset').description('Manage reusable configuration parts');
  presets
    .command('list')
    .alias('ls')
    .requiredOption('--kind <kind>', 'environment, ai, workflow, github-access or tool-pack')
    .option('--json', 'Full configuration JSON')
    .action(async (opts: { kind: string; json?: boolean }) => {
      const kinds: Record<string, ConfigurationKind> = {
        environment: 'environment',
        ai: 'ai',
        workflow: 'workflow',
        'github-access': 'githubAccess',
        'tool-pack': 'toolPack',
      };
      const kind = kinds[opts.kind];
      if (!kind)
        throw new Error(
          'Select a preset kind: environment, ai, workflow, github-access or tool-pack.',
        );
      const entries = await getClient().listConfigurations(kind);
      if (opts.json) output(entries);
      else
        for (const item of entries)
          console.log(
            `${item.id}\t${item.name}\trevision ${item.revision}${item.archived ? '\tarchived' : ''}`,
          );
    });
  for (const [name, kind] of [
    ['environment', 'environment'],
    ['ai', 'ai'],
    ['workflow', 'workflow'],
    ['github-access', 'githubAccess'],
    ['tool-pack', 'toolPack'],
  ] as const)
    registerEntityCommands(presets.command(name), kind, getClient);
  const watcher = program.command('watcher').description('Configure repository issue watchers');
  watcher
    .command('list')
    .option('--json', 'Full watcher configuration')
    .action(async (opts: { json?: boolean }) => {
      const entries = await getClient().listWatcherBindings();
      if (opts.json) output(entries);
      else
        for (const entry of entries)
          console.log(
            `${entry.id}\t${entry.payload.name}\t${entry.payload.enabled ? 'enabled' : 'paused'}\trevision ${entry.revision}`,
          );
    });
  watcher
    .command('create <name>')
    .requiredOption('--repo <repository>', 'Enrolled repository name or ID')
    .option('--profile <profile>', 'Profile name or ID; defaults to the repository usual profile')
    .option('--label-prefix <prefix>', 'Issue label prefix', 'autopod')
    .option('--enabled', 'Enable automatic issue pickup')
    .action(
      async (
        name: string,
        opts: { repo: string; profile?: string; labelPrefix: string; enabled?: boolean },
      ) => {
        const client = getClient();
        const repositoryId = await configurationId('repository', opts.repo, (kind) =>
          client.listConfigurations(kind),
        );
        const profileId = opts.profile
          ? await configurationId('profile', opts.profile, (kind) =>
              client.listConfigurations(kind),
            )
          : undefined;
        output(
          await client.writeWatcherBinding({
            payload: issueWatcherBindingSchema.parse({
              name,
              enabled: !!opts.enabled,
              labelPrefix: opts.labelPrefix,
              launch: { repositoryId, profileId },
            }),
          }),
        );
      },
    );
  watcher
    .command('edit <id>')
    .requiredOption('--file <path>', 'Complete watcher payload JSON, including named label routes')
    .requiredOption('--expected-revision <revision>', 'Revision you edited', revision)
    .action(async (id: string, opts: { file: string; expectedRevision: number }) => {
      output(
        await getClient().writeWatcherBinding({
          id,
          expectedRevision: opts.expectedRevision,
          payload: issueWatcherBindingSchema.parse(jsonFile(opts.file)),
        }),
      );
    });
  program
    .command('pim')
    .description('Discover eligible access for the configured account')
    .command('eligible')
    .option('--json', 'Complete eligibility and exact scope identifiers')
    .action(async (opts: { json?: boolean }) => {
      const result = await getClient().pimEligibility();
      if (opts.json) {
        output(result);
        return;
      }
      for (const family of result.families) {
        if (!family.available) {
          console.log(`${family.type}: ${family.reason}`);
          continue;
        }
        for (const assignment of family.assignments)
          console.log(
            `${assignment.type}\t${assignment.displayName}\t${assignment.scopeName}\t${assignment.eligibilityId}\t${assignment.maximumDurationMinutes === null ? 'Duration policy unavailable' : `Up to ${assignment.maximumDurationMinutes} minutes`}`,
          );
      }
      console.log(
        'Discovery does not activate access. Select exact assignments in profile or launch PIM settings.',
      );
    });
}

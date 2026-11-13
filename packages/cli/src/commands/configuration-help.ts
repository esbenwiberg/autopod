import {
  type ConfigurationHelpKind,
  type ConfigurationHelpTopic,
  configurationHelpKinds,
  configurationHelpTopics,
  findConfigurationHelp,
} from '@autopod/shared';
import type { Command } from 'commander';

interface HelpOptions {
  list?: boolean;
  json?: boolean;
}
function explain(topic: ConfigurationHelpTopic): string {
  return [
    topic.title,
    topic.summary,
    '',
    ...(topic.source ? [`Configured in: ${topic.source}`] : []),
    `When to use it: ${topic.whenToUse}`,
    `What happens: ${topic.behavior}`,
    `Default / off: ${topic.defaultBehavior}`,
    `Impact: ${topic.impact}`,
    ...(topic.options && Object.keys(topic.options).length
      ? ['Choices:', ...Object.entries(topic.options).map(([key, value]) => `  ${key}: ${value}`)]
      : []),
    ...(topic.example ? [`Example: ${topic.example}`] : []),
    ...(topic.paths.length ? [`JSON paths: ${topic.paths.join(', ')}`] : []),
  ].join('\n');
}
function display(
  kind: ConfigurationHelpKind,
  field: string | undefined,
  opts: HelpOptions,
  command: string,
): void {
  const topics = configurationHelpTopics.filter((topic) => topic.id.startsWith(`${kind}.`));
  if (opts.list) {
    console.log(
      opts.json
        ? JSON.stringify(topics, null, 2)
        : topics
            .map(
              (topic) =>
                `${topic.id.slice(kind.length + 1)}\t${topic.title}${topic.paths.length ? `\n  ${topic.paths.join(', ')}` : ''}`,
            )
            .join('\n'),
    );
    return;
  }
  const topic = findConfigurationHelp(field, kind);
  if (!topic)
    throw new Error(
      `No explanation for "${field}". Run ${command} --list for topics and JSON paths.`,
    );
  console.log(opts.json ? JSON.stringify(topic, null, 2) : explain(topic));
}

/** No API client, authentication, discovery or saved-setting mutation. */
export function registerConfigurationHelp(command: Command, kind: ConfigurationHelpKind): void {
  const invocation = `ap ${command.parent?.name() === 'preset' ? 'preset ' : ''}${command.name()} explain`;
  command
    .command('explain [field]')
    .description('Explain settings and their effects offline')
    .option('--list', 'List explanation topics and JSON paths')
    .option('--json', 'Output structured help instead of text')
    .addHelpText(
      'after',
      `\nExamples:\n  ${invocation}\n  ${invocation} --list\n  ${invocation} --list --json\n`,
    )
    .action((field: string | undefined, opts: HelpOptions) =>
      display(kind, field, opts, invocation),
    );
}

export function registerRootConfigurationHelp(program: Command): void {
  program
    .command('explain [field]')
    .description(
      'Browse configuration and desktop-setting explanations offline; performs no action',
    )
    .option('--kind <kind>', configurationHelpKinds.join(', '), 'profile')
    .option('--list', 'List topics for the selected kind')
    .option('--json', 'Output structured help')
    .action((field: string | undefined, opts: HelpOptions & { kind: string }) => {
      const aliases: Record<string, ConfigurationHelpKind> = {
        'tool-pack': 'toolPack',
        'github-access': 'githubAccess',
        'package-feed': 'packageFeed',
        'provider-account': 'providerAccount',
      };
      const kind = aliases[opts.kind] ?? opts.kind;
      if (!configurationHelpKinds.includes(kind as ConfigurationHelpKind))
        throw new Error(`Choose --kind from: ${configurationHelpKinds.join(', ')}`);
      display(kind as ConfigurationHelpKind, field, opts, `ap explain --kind ${opts.kind}`);
    });
}

import catalog from './failover.json' with { type: 'json' };
import instructions from './instructions.json' with { type: 'json' };
import settings from './settings.json' with { type: 'json' };
import validation from './validation.json' with { type: 'json' };

export const configurationHelpKinds = [
  'profile',
  'repository',
  'environment',
  'ai',
  'workflow',
  'githubAccess',
  'toolPack',
  'packageFeed',
  'launch',
  'watcher',
  'deployment',
  'providerAccount',
  'app',
  'podsitter',
] as const;
export type ConfigurationHelpKind = (typeof configurationHelpKinds)[number];

export interface ConfigurationHelpTopic {
  id: string;
  title: string;
  summary: string;
  whenToUse: string;
  behavior: string;
  defaultBehavior: string;
  impact: string;
  example: string;
  paths: string[];
  areas?: string[];
  options?: Record<string, string>;
  source?: string;
  sourceKind?: 'repository' | 'ai' | 'task';
}

/** Static, offline help only. Never part of a saved configuration or launch digest. */
export const configurationHelpTopics: readonly ConfigurationHelpTopic[] = [
  ...catalog.topics,
  ...(validation.topics as ConfigurationHelpTopic[]),
  ...instructions.topics,
  ...(settings.topics as ConfigurationHelpTopic[]),
];

export function findConfigurationHelp(
  field: string | undefined = undefined,
  kind: ConfigurationHelpKind = 'ai',
): ConfigurationHelpTopic | undefined {
  const input =
    field ??
    (
      {
        ai: 'failover',
        workflow: 'validation',
        toolPack: 'instructions',
        profile: 'sections.composition',
        environment: 'sections.runtime',
        githubAccess: 'sections.rules',
        app: 'sections.connections',
      } as Partial<Record<ConfigurationHelpKind, string>>
    )[kind] ??
    'sections.overview';
  const path = input.replace(new RegExp(`^${kind}\\.`), '').replace(/\[\d+\]/g, '[]');
  return configurationHelpTopics.find(
    (topic) =>
      topic.id.startsWith(`${kind}.`) &&
      (topic.id === `${kind}.${path}` ||
        topic.paths.some((pattern) => {
          if (pattern === path || pattern.replace(/\[\]$/, '') === path) return true;
          const expected = pattern.split('.');
          const actual = path.split('.');
          return (
            expected.length === actual.length &&
            expected.every((part, index) => part === '*' || part === actual[index])
          );
        })),
  );
}

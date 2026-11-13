import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configurationPayloadSchemas } from '../schemas/launch-config.schema.js';
import {
  type ConfigurationHelpKind,
  configurationHelpKinds,
  configurationHelpTopics,
  findConfigurationHelp,
} from './index.js';

interface Node {
  type?: string | string[];
  properties?: Record<string, Node>;
  items?: Node;
  additionalProperties?: boolean | Node;
  anyOf?: Node[];
  oneOf?: Node[];
  enum?: unknown[];
  const?: unknown;
}
function fields(
  node: Node,
  path = '',
  out = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  for (const branch of node.anyOf ?? node.oneOf ?? []) fields(branch, path, out);
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties))
      fields(value, path ? `${path}.${key}` : key, out);
  } else if (node.items) fields(node.items, `${path}[]`, out);
  else if (typeof node.additionalProperties === 'object')
    fields(node.additionalProperties, `${path}.*`, out);
  else if (!node.anyOf && !node.oneOf && node.type !== 'null') {
    const choices = out.get(path) ?? new Set<string>();
    for (const value of [...(node.enum ?? []), ...(node.const === undefined ? [] : [node.const])])
      if (typeof value === 'string') choices.add(value);
    out.set(path, choices);
  }
  return out;
}

describe('complete composable-setting coverage', () => {
  it.each(
    Object.entries(configurationPayloadSchemas),
  )('explains every %s leaf and every selectable choice', (kind, schema) => {
    const leaves = fields(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node);
    expect(leaves.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [path, choices] of leaves) {
      const topic = findConfigurationHelp(path, kind as ConfigurationHelpKind);
      if (!topic) {
        missing.push(path);
        continue;
      }
      for (const choice of choices)
        expect(topic.options?.[choice], `${kind}.${path}: ${choice}`).toBeTruthy();
    }
    expect(missing, `Missing ${kind} explanations`).toEqual([]);
  });
  it('has an offline default for each supported configuration or operating context', () => {
    for (const kind of configurationHelpKinds)
      expect(findConfigurationHelp(undefined, kind), kind).toBeDefined();
  });
  it('distinguishes main allocation inheritance from sidecar map replacement', () => {
    for (const key of ['memoryGb', 'cpus', 'storageGb']) {
      expect(
        findConfigurationHelp(`overrides.execution.main.${key}`, 'launch')?.defaultBehavior,
      ).toContain('omitted fields retain Profile');
      expect(
        findConfigurationHelp(`overrides.execution.sidecars.database.${key}`, 'launch')
          ?.defaultBehavior,
      ).toContain('replaces the Profile map');
    }
    expect(
      Object.keys(findConfigurationHelp('source.configuration', 'launch')?.options ?? {}).sort(),
    ).toEqual(['current', 'original', 'worker']);
  });
  it('resolves actual sidecar/value-map entries and keeps kinds isolated', () => {
    expect(findConfigurationHelp('execution.sidecars.database.memoryGb', 'profile')?.id).toBe(
      'profile.memoryGb',
    );
    expect(findConfigurationHelp('setups[0].buildEnv.NODE_OPTIONS.value', 'repository')?.id).toBe(
      'repository.setup.env',
    );
    expect(findConfigurationHelp('theme', 'app')?.behavior).toContain('this Mac');
    expect(findConfigurationHelp('instructions', 'profile')).toBeUndefined();
    expect(
      configurationHelpTopics.find((t) => t.id === 'podsitter.sections.overview')?.impact,
    ).toContain('force completion');
  });
});

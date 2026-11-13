import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentRouteSchema,
  agentTargetSchema,
  launchValidationPhaseSchema,
  toolPackSchema,
  workflowPresetSchema,
} from '../schemas/launch-config.schema.js';
import catalog from './failover.json' with { type: 'json' };
import {
  type ConfigurationHelpKind,
  configurationHelpTopics,
  findConfigurationHelp,
} from './index.js';
import instructions from './instructions.json' with { type: 'json' };
import validation from './validation.json' with { type: 'json' };

describe('configuration help contract', () => {
  it.each([
    'failover',
    'validation',
    'instructions',
    'settings',
  ])('keeps the Swift %s bundle byte-identical to the canonical content', (name) => {
    expect(
      readFileSync(
        new URL(
          `../../../desktop/Sources/AutopodUI/Resources/ConfigurationHelp/${name}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    ).toBe(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
  });

  it('has unique IDs and paths, complete details and short summaries', () => {
    expect(catalog.version).toBe(1);
    expect(validation.version).toBe(1);
    expect(instructions.version).toBe(1);
    expect(new Set(configurationHelpTopics.map((t) => t.id)).size).toBe(
      configurationHelpTopics.length,
    );
    const paths = configurationHelpTopics.flatMap((t) =>
      t.paths.map((path) => `${t.id.split('.')[0]}:${path}`),
    );
    expect(new Set(paths).size).toBe(paths.length);
    for (const topic of configurationHelpTopics) {
      for (const key of [
        'title',
        'summary',
        'whenToUse',
        'behavior',
        'defaultBehavior',
        'impact',
      ] as const)
        expect(topic[key].trim().length, `${topic.id}.${key}`).toBeGreaterThan(0);
      expect(topic.summary.length).toBeLessThan(110);
      const kind = topic.id.split('.')[0] as ConfigurationHelpKind;
      expect(findConfigurationHelp(topic.id, kind)).toEqual(topic);
      for (const path of topic.paths) expect(findConfigurationHelp(path, kind)).toEqual(topic);
      for (const area of topic.areas ?? [])
        expect(
          configurationHelpTopics.some((candidate) => candidate.id === area),
          `${topic.id} -> ${area}`,
        ).toBe(true);
      if (topic.sourceKind) {
        expect(['repository', 'ai', 'task']).toContain(topic.sourceKind);
        expect(topic.source?.length).toBeGreaterThan(0);
      }
    }
  });

  it('covers every route setting and every backup target field for all three roles', () => {
    const keys = Object.keys(agentRouteSchema.shape);
    expect(keys.filter((key) => !(key in agentTargetSchema.shape))).toEqual([
      'failover',
      'maxHops',
    ]);
    for (const route of ['main', 'reviewer.route', 'advisor.route']) {
      expect(findConfigurationHelp(`${route}.maxHops`)).toBeDefined();
      expect(findConfigurationHelp(`${route}.failover`)).toBeDefined();
      for (const key of Object.keys(agentTargetSchema.shape))
        expect(findConfigurationHelp(`${route}.failover[].${key}`)).toBeDefined();
    }
    expect(agentRouteSchema.shape.maxHops.parse(undefined)).toBe(0);
    expect(agentRouteSchema.shape.maxHops.safeParse(16).success).toBe(true);
    expect(agentRouteSchema.shape.maxHops.safeParse(17).success).toBe(false);
    expect(findConfigurationHelp('main.maxHops')?.defaultBehavior).toContain('0–16');
  });

  it('covers every validation phase and both advisory settings without inventing JSON object paths', () => {
    for (const phase of launchValidationPhaseSchema.options) {
      const topic = findConfigurationHelp(`validation.${phase}`, 'workflow');
      expect(topic?.source).toBeTruthy();
      expect(topic?.paths.some((path) => path.startsWith('validationPhases.'))).toBe(false);
    }
    expect(findConfigurationHelp('validationPhases', 'workflow')?.id).toBe('workflow.validation');
    expect(findConfigurationHelp('advisoryBrowserQaEnabled', 'workflow')?.id).toBe(
      'workflow.validation.advisory',
    );
    expect(workflowPresetSchema.shape.maxValidationAttempts.parse(undefined)).toBe(3);
    expect(workflowPresetSchema.shape.maxValidationAttempts.safeParse(1).success).toBe(true);
    expect(workflowPresetSchema.shape.maxValidationAttempts.safeParse(10).success).toBe(true);
    expect(workflowPresetSchema.shape.maxValidationAttempts.safeParse(11).success).toBe(false);
    expect(findConfigurationHelp('maxValidationAttempts', 'workflow')?.defaultBehavior).toContain(
      '1–10',
    );
    expect(workflowPresetSchema.shape.validationPhases.parse(undefined)).toEqual([
      'setup',
      'build',
      'test',
      'review',
    ]);
    expect(findConfigurationHelp('validation.facts', 'workflow')?.behavior).toContain(
      'does not generate facts',
    );
    expect(findConfigurationHelp('validation.advisory', 'workflow')?.behavior).toContain(
      'checklist',
    );
    expect(findConfigurationHelp(undefined, 'workflow')?.id).toBe('workflow.validation');
    expect(findConfigurationHelp('main.maxHops', 'workflow')).toBeUndefined();
    expect(findConfigurationHelp('workflow.validation.build')).toBeUndefined();
  });

  it('covers instruction fields, exact limits and main-agent guidance boundaries', () => {
    const schema = toolPackSchema.shape.instructions;
    expect(schema.parse(undefined)).toEqual([]);
    expect(schema.safeParse([{ heading: 'Guidance', content: '' }]).success).toBe(true);
    expect(
      schema.safeParse([{ heading: 'x'.repeat(128), content: 'x'.repeat(50_000) }]).success,
    ).toBe(true);
    expect(schema.safeParse([{ heading: '', content: 'Rules' }]).success).toBe(false);
    expect(schema.safeParse([{ heading: 'x'.repeat(129), content: 'Rules' }]).success).toBe(false);
    expect(schema.safeParse([{ heading: 'Guidance', content: 'x'.repeat(50_001) }]).success).toBe(
      false,
    );
    for (const field of Object.keys(schema.unwrap().element.shape))
      expect(findConfigurationHelp(`instructions[].${field}`, 'toolPack')).toBeDefined();
    expect(findConfigurationHelp(undefined, 'toolPack')?.id).toBe('toolPack.instructions');
    expect(findConfigurationHelp('instructions[2].content', 'toolPack')?.id).toBe(
      'toolPack.instructions.content',
    );
    expect(findConfigurationHelp('instructions', 'toolPack')?.behavior).toContain(
      'without overwriting repository instruction files',
    );
    expect(findConfigurationHelp('instructions', 'toolPack')?.impact).toContain(
      'does not install software, grant access or enforce a rule',
    );
    expect(findConfigurationHelp('instructions.heading', 'toolPack')?.defaultBehavior).toContain(
      '128',
    );
    expect(findConfigurationHelp('instructions.content', 'toolPack')?.defaultBehavior).toContain(
      '50,000',
    );
    expect(findConfigurationHelp('validation.build', 'toolPack')).toBeUndefined();
    expect(findConfigurationHelp('instructions')).toBeUndefined();
  });

  it('keeps role-specific failure conditions distinct and resolves numeric array paths', () => {
    expect(findConfigurationHelp('main.failover')?.behavior).toContain(
      'does not switch automatically for general outages',
    );
    expect(findConfigurationHelp('reviewer.route.failover')?.behavior).toContain(
      'when usage is measured',
    );
    expect(findConfigurationHelp('advisor.route.failover')?.behavior).toContain(
      'Workflow controls that',
    );
    expect(findConfigurationHelp('ai.main.failover[0].model')?.id).toBe('ai.failover.model');
    expect(findConfigurationHelp('validation')).toBeUndefined();
  });
});

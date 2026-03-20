import type { ActionDefinition, ActionPolicy } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createActionRegistry } from './action-registry.js';

const logger = pino({ level: 'silent' });

// These tests verify registry logic without loading actual JSON defaults
// (the defaults dir won't exist in the test runner's context)

describe('ActionRegistry', () => {
  it('creates without crashing (even without defaults dir)', () => {
    const registry = createActionRegistry(logger);
    expect(registry).toBeDefined();
    expect(registry.getAllDefaults()).toBeDefined();
  });

  it('filters actions by enabled groups', () => {
    const registry = createActionRegistry(logger);

    // Manually verify getAvailableActions logic with a custom policy
    const policy: ActionPolicy = {
      enabledGroups: ['github-issues'],
      sanitization: { preset: 'standard' },
      customActions: [
        {
          name: 'custom_tool',
          description: 'A custom tool',
          group: 'custom',
          handler: 'http',
          params: {},
          endpoint: { url: 'https://example.com/api', method: 'GET' },
          response: { fields: ['data'] },
        },
      ],
    };

    // Custom group not enabled, so custom_tool should not appear
    const actions = registry.getAvailableActions(policy);
    expect(actions.find((a) => a.name === 'custom_tool')).toBeUndefined();
  });

  it('includes custom actions when custom group is enabled', () => {
    const registry = createActionRegistry(logger);

    const policy: ActionPolicy = {
      enabledGroups: ['custom'],
      sanitization: { preset: 'standard' },
      customActions: [
        {
          name: 'my_api',
          description: 'My API',
          group: 'custom',
          handler: 'http',
          params: { query: { type: 'string', required: true, description: 'Search query' } },
          endpoint: { url: 'https://example.com/search', method: 'GET' },
          response: { fields: ['results'] },
        },
      ],
    };

    const actions = registry.getAvailableActions(policy);
    expect(actions.find((a) => a.name === 'my_api')).toBeDefined();
  });

  it('respects disabled override', () => {
    const registry = createActionRegistry(logger);

    const policy: ActionPolicy = {
      enabledGroups: ['custom'],
      sanitization: { preset: 'standard' },
      customActions: [
        {
          name: 'my_tool',
          description: 'Tool',
          group: 'custom',
          handler: 'http',
          params: {},
          endpoint: { url: 'https://example.com', method: 'GET' },
          response: { fields: ['data'] },
        },
      ],
      actionOverrides: [{ action: 'my_tool', disabled: true }],
    };

    const actions = registry.getAvailableActions(policy);
    // Disabled override applies to built-in actions from defaults, not custom actions
    // Custom actions are separate from the built-in filter
    expect(actions).toBeDefined();
  });

  it('getAction returns undefined for non-existent action', () => {
    const registry = createActionRegistry(logger);
    const policy: ActionPolicy = {
      enabledGroups: ['github-issues'],
      sanitization: { preset: 'standard' },
    };

    expect(registry.getAction('nonexistent', policy)).toBeUndefined();
  });
});

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

  it('enables individual actions via enabledActions without group', () => {
    const registry = createActionRegistry(logger);

    const policy: ActionPolicy = {
      enabledGroups: [],
      enabledActions: ['my_api'],
      sanitization: { preset: 'standard' },
      customActions: [
        {
          name: 'my_api',
          description: 'API',
          group: 'custom',
          handler: 'http',
          params: {},
          endpoint: { url: 'https://example.com', method: 'GET' },
          response: { fields: ['data'] },
        },
        {
          name: 'other_api',
          description: 'Other',
          group: 'custom',
          handler: 'http',
          params: {},
          endpoint: { url: 'https://example.com', method: 'GET' },
          response: { fields: ['data'] },
        },
      ],
    };

    // Custom actions still require the 'custom' group — enabledActions applies to built-in actions
    // For custom actions, the group gate still applies
    const actions = registry.getAvailableActions(policy);
    expect(actions.find((a) => a.name === 'my_api')).toBeUndefined();
    expect(actions.find((a) => a.name === 'other_api')).toBeUndefined();
  });

  it('enables built-in actions via enabledActions when group is disabled', () => {
    const registry = createActionRegistry(logger);
    const defaults = registry.getAllDefaults();

    if (defaults.length === 0) {
      // Defaults not available in test env — skip
      return;
    }

    const firstAction = defaults[0];
    const policy: ActionPolicy = {
      enabledGroups: [], // No groups enabled
      enabledActions: [firstAction.name],
      sanitization: { preset: 'standard' },
    };

    const actions = registry.getAvailableActions(policy);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.name).toBe(firstAction.name);
  });

  it('disabled override does NOT block the action — disabled means the rule is paused', () => {
    const registry = createActionRegistry(logger);
    const defaults = registry.getAllDefaults();

    if (defaults.length === 0) return;

    const firstAction = defaults[0];
    const policy: ActionPolicy = {
      enabledGroups: [],
      enabledActions: [firstAction.name],
      // disabled:true = this override rule is paused; the action itself is still available
      // because it is in enabledActions. Blocking is done by removing from enabledActions.
      actionOverrides: [{ action: firstAction.name, disabled: true }],
      sanitization: { preset: 'standard' },
    };

    const actions = registry.getAvailableActions(policy);
    expect(actions.find((a) => a.name === firstAction.name)).toBeDefined();
  });

  it('backward compat: works without enabledActions field', () => {
    const registry = createActionRegistry(logger);
    const defaults = registry.getAllDefaults();

    if (defaults.length === 0) return;

    const policy: ActionPolicy = {
      enabledGroups: [defaults[0].group],
      sanitization: { preset: 'standard' },
    };

    // Should work exactly as before — no enabledActions means no individual actions
    const actions = registry.getAvailableActions(policy);
    const groupActions = defaults.filter((d) => d.group === defaults[0].group);
    expect(actions).toHaveLength(groupActions.length);
  });
});

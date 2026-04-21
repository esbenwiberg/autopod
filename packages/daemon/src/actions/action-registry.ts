import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionDefinition, ActionPolicy } from '@autopod/shared';
import { actionDefinitionSchema } from '@autopod/shared';
import type { Logger } from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When bundled into dist/index.js, __dirname = dist/ so the naive '../actions/defaults'
// resolves to <package-root>/actions/defaults (wrong). Try the bundled path first,
// then fall back to the source path (works when running unbundled in tests).
const DEFAULTS_DIR =
  [
    join(__dirname, 'actions', 'defaults'), // bundled: dist/actions/defaults
    join(__dirname, '..', 'actions', 'defaults'), // source: src/actions/defaults
    join(__dirname, '..', 'src', 'actions', 'defaults'), // absolute fallback
  ].find((d) => existsSync(d)) ?? join(__dirname, '..', 'src', 'actions', 'defaults');

export interface ActionRegistry {
  /** Get all actions available for a given policy (built-in filtered by enabledGroups + custom) */
  getAvailableActions(policy: ActionPolicy): ActionDefinition[];
  /** Get a specific action by name, respecting the policy */
  getAction(name: string, policy: ActionPolicy): ActionDefinition | undefined;
  /** Get all built-in actions (unfiltered) */
  getAllDefaults(): ActionDefinition[];
}

export function createActionRegistry(logger: Logger): ActionRegistry {
  const defaults = loadDefaults(logger);

  return {
    getAvailableActions(policy: ActionPolicy): ActionDefinition[] {
      const enabledGroups = new Set(policy.enabledGroups);
      const enabledActions = new Set(policy.enabledActions ?? []);

      // Filter built-in actions by enabled groups/actions only.
      // disabled:true on an override means the override RULE is paused — it does NOT block the
      // action.  Blocking is done by removing the action from enabledGroups / enabledActions.
      // The engine skips disabled overrides when evaluating allowedResources / requiresApproval.
      const builtIn = defaults.filter((action) => {
        return enabledGroups.has(action.group) || enabledActions.has(action.name);
      });

      // Add custom actions (always group: 'custom')
      const custom = (policy.customActions ?? []).filter(() => {
        return enabledGroups.has('custom');
      });

      // Profile custom actions can override built-in by name
      const customNames = new Set(custom.map((a) => a.name));
      const merged = builtIn.filter((a) => !customNames.has(a.name));
      merged.push(...custom);

      return merged;
    },

    getAction(name: string, policy: ActionPolicy): ActionDefinition | undefined {
      return this.getAvailableActions(policy).find((a) => a.name === name);
    },

    getAllDefaults(): ActionDefinition[] {
      return [...defaults];
    },
  };
}

function loadDefaults(logger: Logger): ActionDefinition[] {
  const actions: ActionDefinition[] = [];

  let files: string[];
  try {
    files = readdirSync(DEFAULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    // Defaults directory may not exist in test environments
    logger.warn('No action defaults directory found — running without built-in actions');
    return [];
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(DEFAULTS_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw) as unknown[];

      for (const def of parsed) {
        const result = actionDefinitionSchema.safeParse(def);
        if (result.success) {
          actions.push(result.data as ActionDefinition);
        } else {
          logger.warn(
            { file, errors: result.error.issues },
            'Invalid action definition — skipping',
          );
        }
      }
    } catch (err) {
      logger.error({ err, file }, 'Failed to load action defaults file');
    }
  }

  logger.info({ count: actions.length }, 'Loaded built-in action definitions');
  return actions;
}

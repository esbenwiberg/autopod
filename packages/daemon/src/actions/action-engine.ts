import type {
  ActionDefinition,
  ActionPolicy,
  ActionRequest,
  ActionResponse,
} from '@autopod/shared';
import { processContentDeep } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionRegistry } from './action-registry.js';
import type { ActionAuditRepository } from './audit-repository.js';
import { createGenericHttpHandler } from './generic-http-handler.js';
import { createAdoHandler } from './handlers/ado-handler.js';
import { createAzureLogsHandler } from './handlers/azure-logs-handler.js';
import { createGitHubHandler } from './handlers/github-handler.js';
import type { ActionHandler, HandlerConfig } from './handlers/handler.js';

export interface ActionEngine {
  /** Execute an action for a session */
  execute(request: ActionRequest, policy: ActionPolicy): Promise<ActionResponse>;
  /** Get all available action definitions for a policy */
  getAvailableActions(policy: ActionPolicy): ActionDefinition[];
}

export interface ActionEngineDependencies {
  registry: ActionRegistry;
  auditRepo: ActionAuditRepository;
  logger: Logger;
  getSecret: (ref: string) => string | undefined;
}

export function createActionEngine(deps: ActionEngineDependencies): ActionEngine {
  const { registry, auditRepo, logger, getSecret } = deps;
  const log = logger.child({ component: 'action-engine' });

  // Create handler instances
  const handlerConfig: HandlerConfig = { logger: log, getSecret };
  const handlers: Record<string, ActionHandler> = {
    github: createGitHubHandler(handlerConfig),
    ado: createAdoHandler(handlerConfig),
    'azure-logs': createAzureLogsHandler(handlerConfig),
    http: createGenericHttpHandler(handlerConfig),
  };

  return {
    async execute(request: ActionRequest, policy: ActionPolicy): Promise<ActionResponse> {
      const { sessionId, actionName, params } = request;

      // 1. Resolve the action definition
      const action = registry.getAction(actionName, policy);
      if (!action) {
        log.warn({ sessionId, actionName }, 'Action not found or not enabled');
        return {
          success: false,
          error: `Action '${actionName}' not found or not enabled for this profile`,
          sanitized: false,
          quarantined: false,
        };
      }

      // 2. Check overrides (approval required, resource restrictions)
      const override = (policy.actionOverrides ?? []).find((o) => o.action === actionName);
      if (override?.requiresApproval) {
        return {
          success: false,
          error: `Action '${actionName}' requires human approval`,
          sanitized: false,
          quarantined: false,
        };
      }
      if (override?.allowedResources?.length) {
        const resource = (params.repo as string) ?? (params.org as string);
        if (!resource) {
          // allowedResources is set but the action carries no repo/org identifier —
          // deny to prevent bypassing resource restrictions via resource-agnostic params.
          log.warn(
            { sessionId, actionName },
            'allowedResources set but action has no repo/org param — denying',
          );
          return {
            success: false,
            error: `Action '${actionName}' is blocked: allowedResources is configured but no resource identifier was provided`,
            sanitized: false,
            quarantined: false,
          };
        }
        if (!override.allowedResources.includes(resource)) {
          return {
            success: false,
            error: `Action '${actionName}' not allowed for resource '${resource}'`,
            sanitized: false,
            quarantined: false,
          };
        }
      }

      // 3. Validate required params
      const validationError = validateParams(action, params);
      if (validationError) {
        return { success: false, error: validationError, sanitized: false, quarantined: false };
      }

      // 4. Apply defaults for optional params
      const resolvedParams = applyDefaults(action, params);

      // 5. Dispatch to handler
      const handler = handlers[action.handler];
      if (!handler) {
        return {
          success: false,
          error: `No handler registered for '${action.handler}'`,
          sanitized: false,
          quarantined: false,
        };
      }

      let rawData: unknown;
      try {
        rawData = await handler.execute(action, resolvedParams);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, sessionId, actionName }, 'Action handler failed');

        auditRepo.insert({
          sessionId,
          actionName,
          params: sanitizeParamsForAudit(resolvedParams),
          responseSummary: `ERROR: ${message.slice(0, 200)}`,
          piiDetected: false,
          quarantineScore: 0,
        });

        return { success: false, error: message, sanitized: false, quarantined: false };
      }

      // 6. Process content (quarantine → PII sanitize)
      const {
        result: processedData,
        sanitized,
        quarantined,
        threats,
      } = processContentDeep(
        rawData,
        {
          sanitization: policy.sanitization,
          quarantine: policy.quarantine,
        },
        action.response.redactFields,
      );

      const threatScore = threats.length > 0 ? Math.max(...threats.map((t) => t.severity)) : 0;

      // 7. Audit log
      auditRepo.insert({
        sessionId,
        actionName,
        params: sanitizeParamsForAudit(resolvedParams),
        responseSummary: summarizeResponse(processedData),
        piiDetected: sanitized,
        quarantineScore: threatScore,
      });

      log.info({ sessionId, actionName, sanitized, quarantined, threatScore }, 'Action executed');

      return { success: true, data: processedData, sanitized, quarantined };
    },

    getAvailableActions(policy: ActionPolicy): ActionDefinition[] {
      return registry.getAvailableActions(policy);
    },
  };
}

function validateParams(action: ActionDefinition, params: Record<string, unknown>): string | null {
  for (const [name, def] of Object.entries(action.params)) {
    if (def.required && (params[name] === undefined || params[name] === null)) {
      return `Missing required parameter: ${name}`;
    }
    if (params[name] !== undefined && params[name] !== null) {
      const value = params[name];
      const expectedType = def.type;
      const actualType = typeof value;

      if (expectedType === 'number' && actualType !== 'number') {
        return `Parameter '${name}' must be a number, got ${actualType}`;
      }
      if (expectedType === 'string' && actualType !== 'string') {
        return `Parameter '${name}' must be a string, got ${actualType}`;
      }
      if (expectedType === 'boolean' && actualType !== 'boolean') {
        return `Parameter '${name}' must be a boolean, got ${actualType}`;
      }
      if (def.enum && !def.enum.includes(String(value))) {
        return `Parameter '${name}' must be one of: ${def.enum.join(', ')}`;
      }
    }
  }
  return null;
}

function applyDefaults(
  action: ActionDefinition,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = { ...params };
  for (const [name, def] of Object.entries(action.params)) {
    if (resolved[name] === undefined && def.default !== undefined) {
      resolved[name] = def.default;
    }
  }
  return resolved;
}

/** Remove potentially sensitive values from params before audit logging */
function sanitizeParamsForAudit(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = `${value.slice(0, 100)}... [truncated]`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function summarizeResponse(data: unknown): string {
  if (data === null || data === undefined) return 'null';
  if (Array.isArray(data)) return `[${data.length} items]`;
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    return `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}}`;
  }
  return String(data).slice(0, 200);
}

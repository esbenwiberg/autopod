import type {
  ActionDefinition,
  ActionPolicy,
  ActionRequest,
  ActionResponse,
} from '@autopod/shared';
import { processContentDeep } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodRepository } from '../pods/pod-repository.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ActionRegistry } from './action-registry.js';
import type { ActionAuditRepository } from './audit-repository.js';
import { createGenericHttpHandler } from './generic-http-handler.js';
import { createAdoHandler } from './handlers/ado-handler.js';
import { createAzureLogsHandler } from './handlers/azure-logs-handler.js';
import { createAzurePimHandler } from './handlers/azure-pim-handler.js';
import { createDeployHandler } from './handlers/deploy-handler.js';
import { createGitHubHandler } from './handlers/github-handler.js';
import type { ActionHandler, HandlerConfig } from './handlers/handler.js';
import { createTestPipelineHandler } from './handlers/test-pipeline-handler.js';

export interface ActionEngine {
  /** Execute an action for a pod */
  execute(request: ActionRequest, policy: ActionPolicy): Promise<ActionResponse>;
  /** Get all available action definitions for a policy */
  getAvailableActions(policy: ActionPolicy): ActionDefinition[];
}

export interface ActionEngineDependencies {
  registry: ActionRegistry;
  auditRepo: ActionAuditRepository;
  logger: Logger;
  getSecret: (ref: string) => string | undefined;
  /**
   * Override for the SSRF guard used by the generic HTTP handler. Defaults to
   * `assertPublicUrl` (rejects private/loopback/metadata addresses). Tests
   * that hit a localhost mock server may pass a permissive override.
   */
  ssrfGuard?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Optional — required only when the `test-pipeline` or `deploy` handler is used. */
  podRepo?: PodRepository;
  /** Optional — required only when the `test-pipeline` or `deploy` handler is used. */
  profileStore?: ProfileStore;
}

export function createActionEngine(deps: ActionEngineDependencies): ActionEngine {
  const { registry, auditRepo, logger, getSecret, ssrfGuard, podRepo, profileStore } = deps;
  const log = logger.child({ component: 'action-engine' });

  // Create handler instances
  const handlerConfig: HandlerConfig = { logger: log, getSecret, ssrfGuard };
  const handlers: Record<string, ActionHandler> = {
    github: createGitHubHandler(handlerConfig),
    ado: createAdoHandler(handlerConfig),
    'azure-logs': createAzureLogsHandler(handlerConfig),
    'azure-pim': createAzurePimHandler(handlerConfig),
    http: createGenericHttpHandler(handlerConfig),
  };
  if (podRepo && profileStore) {
    handlers['test-pipeline'] = createTestPipelineHandler({
      logger: log,
      podRepo,
      profileStore,
    });
  }
  if (podRepo && profileStore) {
    handlers.deploy = createDeployHandler({
      podRepo,
      profileStore,
      daemonEnv: process.env,
    });
  }

  return {
    async execute(request: ActionRequest, policy: ActionPolicy): Promise<ActionResponse> {
      const { podId, actionName, params } = request;

      // 1. Resolve the action definition
      const action = registry.getAction(actionName, policy);
      if (!action) {
        log.warn({ podId, actionName }, 'Action not found or not enabled');
        return {
          success: false,
          error: `Action '${actionName}' not found or not enabled for this profile`,
          sanitized: false,
          quarantined: false,
        };
      }

      // 2. Check overrides (approval required, resource restrictions)
      // Collect ALL active (non-disabled) overrides for this action and merge their constraints.
      // Multiple overrides per action are used to grant access to several specific repos —
      // using .find() would only honour the first one and silently block the rest.
      const activeOverrides = (policy.actionOverrides ?? []).filter(
        (o) => o.action === actionName && !o.disabled,
      );
      const requiresApproval = activeOverrides.some((o) => o.requiresApproval);
      const allAllowedResources = activeOverrides.flatMap((o) => o.allowedResources ?? []);

      if (requiresApproval && !request.skipApprovalCheck) {
        return {
          success: false,
          error: `Action '${actionName}' requires human approval. This check should be handled by the MCP layer — if you see this, the approval flow was bypassed.`,
          sanitized: false,
          quarantined: false,
        };
      }
      if (allAllowedResources.length > 0) {
        // Build the most-specific resource identifier available.
        // ADO actions pass org + project + repo as separate params; combine them so
        // allowedResources patterns like "365projectum/TeamPlanner@V3@" can match
        // against calls that specify any repo within that org/project.
        const resource =
          buildResourceId(params) ??
          (params.scope as string) ?? // Azure RBAC PIM role actions
          (params.group_id as string); // Azure PIM group actions
        if (!resource) {
          // allowedResources is set but the action carries no repo/org identifier —
          // deny to prevent bypassing resource restrictions via resource-agnostic params.
          log.warn(
            { podId, actionName },
            'allowedResources set but action has no repo/org param — denying',
          );
          return {
            success: false,
            error: `Action '${actionName}' is blocked: allowedResources is configured but no resource identifier was provided`,
            sanitized: false,
            quarantined: false,
          };
        }
        if (!matchesResource(resource, allAllowedResources)) {
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
        rawData = await handler.execute(action, resolvedParams, {
          podId,
          approvalContext: request.approvalContext,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, podId, actionName }, 'Action handler failed');

        auditRepo.insert({
          podId,
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
        podId,
        actionName,
        params: sanitizeParamsForAudit(resolvedParams),
        responseSummary: summarizeResponse(processedData),
        piiDetected: sanitized,
        quarantineScore: threatScore,
      });

      log.info({ podId, actionName, sanitized, quarantined, threatScore }, 'Action executed');

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

const SENSITIVE_PARAM_PATTERN = /token|password|secret|pat|key|credential|auth|bearer|api[_-]?key/i;

/** Remove potentially sensitive values from params before audit logging */
function sanitizeParamsForAudit(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_PARAM_PATTERN.test(key)) {
      sanitized[key] = '[redacted]';
    } else if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = `${value.slice(0, 100)}... [truncated]`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Check whether a resource matches any pattern in the allowlist.
 * Supported pattern syntax:
 *   '*'             — allow any resource
 *   'org/*'         — allow all repos within the org (explicit wildcard)
 *   'org/project'   — allow any repo within the org/project (prefix-segment match)
 *   'org/repo'      — exact match
 *
 * Both sides are URL-decoded before comparison so that patterns copy-pasted from
 * ADO URLs (e.g. "org/TeamPlanner%40-V3%40") match the raw params the agent passes.
 * Prefix-segment matching means "org/project" covers "org/project/repo" without
 * requiring users to append "/*" to every scope.
 */
function matchesResource(resource: string, patterns: string[]): boolean {
  const decoded = safeDecodeURIComponent(resource);
  return patterns.some((p) => {
    const decodedP = safeDecodeURIComponent(p);
    if (decodedP === '*') return true;
    if (decodedP.endsWith('/*')) return decoded.startsWith(decodedP.slice(0, -1));
    if (decoded.startsWith(`${decodedP}/`)) return true;
    return decodedP === decoded;
  });
}

/**
 * Build the most-specific hierarchical resource identifier from action params.
 * For ADO actions (separate org + project + repo params) this produces "org/project/repo"
 * so that allowedResources patterns like "org/project" match via prefix-segment logic.
 */
function buildResourceId(params: Record<string, unknown>): string | undefined {
  const org = params.org as string | undefined;
  const project = params.project as string | undefined;
  const repo = params.repo as string | undefined;
  if (org && project && repo) return `${org}/${project}/${repo}`;
  if (org && project) return `${org}/${project}`;
  if (org && repo) return `${org}/${repo}`;
  return repo ?? org;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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

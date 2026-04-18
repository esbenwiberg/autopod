import type { ActionDefinition } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionHandler, HandlerConfig } from './handler.js';
import { fetchWithTimeout, readSafeJson } from './handler.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const PIM_ENDPOINT = `${GRAPH_API}/identityGovernance/privilegedAccess/group/assignmentScheduleRequests`;
const PIM_SCHEDULES_ENDPOINT = `${GRAPH_API}/identityGovernance/privilegedAccess/group/assignmentSchedules`;
const ARM_API = 'https://management.azure.com';
const ARM_RBAC_API_VERSION = '2020-10-01';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cachedGraphToken: CachedToken | null = null;
let cachedArmToken: CachedToken | null = null;

async function getTokenFromAzCli(resource: string, log: Logger): Promise<CachedToken | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
      { timeout: 15_000 },
    );

    const parsed = JSON.parse(stdout) as { accessToken?: string; expiresOn?: string };
    if (!parsed.accessToken) return null;

    const expiresAtMs = parsed.expiresOn
      ? new Date(parsed.expiresOn).getTime() - TOKEN_REFRESH_BUFFER_MS
      : Date.now() + 3600_000 - TOKEN_REFRESH_BUFFER_MS;

    log.debug({ resource }, 'Azure CLI token acquired');
    return { token: parsed.accessToken, expiresAtMs };
  } catch {
    return null;
  }
}

async function getArmToken(
  getSecret: (ref: string) => string | undefined,
  log: Logger,
): Promise<string> {
  const directToken = getSecret('AZURE_ARM_TOKEN');
  if (directToken) return directToken;

  if (cachedArmToken && Date.now() < cachedArmToken.expiresAtMs) {
    return cachedArmToken.token;
  }

  let identityErr: string | undefined;
  try {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://management.azure.com/.default');
    cachedArmToken = {
      token: tokenResponse.token,
      expiresAtMs:
        (tokenResponse.expiresOnTimestamp ?? Date.now() + 3600_000) - TOKEN_REFRESH_BUFFER_MS,
    };
    log.debug('Azure ARM managed identity token refreshed');
    return cachedArmToken.token;
  } catch (err) {
    identityErr = err instanceof Error ? err.message : String(err);
    log.debug(
      { err: identityErr },
      'DefaultAzureCredential failed for ARM, trying az CLI fallback',
    );
  }

  // Azure CLI fallback (az account get-access-token)
  const azResult = await getTokenFromAzCli('https://management.azure.com', log);
  if (azResult) {
    cachedArmToken = azResult;
    return azResult.token;
  }

  cachedArmToken = null;
  throw new Error(
    `Azure ARM auth failed — configure AZURE_ARM_TOKEN, ensure Managed Identity is available, or log in with 'az login'. Identity error: ${identityErr}`,
  );
}

/** Looks up the eligible role assignment for SelfActivate.
 * Returns both the eligibilityScheduleId and the scope from the API (use that, not config scope). */
async function findEligibilitySchedule(
  token: string,
  fullRoleDefId: string,
  normScope: string, // no leading slash — used for matching only, not in the URL
  log: Logger,
): Promise<{ eligibilityScheduleId: string; scope: string }> {
  // Tenant-root URL + asTarget() — no scope prefix, no principalId filter needed.
  // asTarget() already scopes to the calling identity; adding a scope prefix causes 400/403.
  const url = `${ARM_API}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?$filter=asTarget()&api-version=${ARM_RBAC_API_VERSION}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to list role eligibility schedule instances ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await readSafeJson(response)) as {
    value?: Array<{
      properties: {
        principalId: string;
        roleDefinitionId: string;
        scope?: string;
        roleEligibilityScheduleId: string;
      };
    }>;
  };
  const norm = (s: string) => s.toLowerCase().replace(/\/+$/, '');
  const candidates = (data.value ?? []).filter(
    (s) => norm(s.properties.roleDefinitionId) === norm(fullRoleDefId),
  );
  // Prefer exact scope match, fall back to any candidate with the right role
  const exact = candidates.find((s) => norm(s.properties.scope ?? '') === norm(`/${normScope}`));
  const match = exact ?? candidates[0];
  if (!match) {
    throw new Error(
      `No eligible PIM role assignment found for role '${fullRoleDefId}' at scope '/${normScope}'. Ensure this account has an eligible assignment in Azure PIM.`,
    );
  }
  const scope = match.properties.scope ?? `/${normScope}`;
  log.debug(
    {
      eligibilityScheduleId: match.properties.roleEligibilityScheduleId,
      scope,
      principalId: match.properties.principalId,
    },
    'Found role eligibility schedule for SelfActivate',
  );
  return {
    eligibilityScheduleId: match.properties.roleEligibilityScheduleId,
    scope,
    principalId: match.properties.principalId,
  };
}

/** Checks if a role is already active (for deactivate or skip-duplicate logic).
 * Returns { roleAssignmentScheduleId, principalId } if active, null if not.
 * principalId comes from the API response (real AAD OID) — never trust pod.userId. */
async function findActiveAssignment(
  token: string,
  fullRoleDefId: string,
  normScope: string, // no leading slash — used for matching only
  log: Logger,
): Promise<{ roleAssignmentScheduleId: string; principalId: string } | null> {
  // Tenant-root URL + asTarget() — same pattern as eligibility lookup.
  const url = `${ARM_API}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?$filter=asTarget()&api-version=${ARM_RBAC_API_VERSION}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to list role assignment schedule instances ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await readSafeJson(response)) as {
    value?: Array<{
      properties: {
        principalId: string;
        roleDefinitionId: string;
        scope?: string;
        assignmentType?: string;
        roleAssignmentScheduleId: string;
      };
    }>;
  };
  const norm = (s: string) => s.toLowerCase().replace(/\/+$/, '');
  const candidates = (data.value ?? []).filter(
    (s) =>
      norm(s.properties.roleDefinitionId) === norm(fullRoleDefId) &&
      s.properties.assignmentType === 'Activated',
  );
  const exact = candidates.find((s) => norm(s.properties.scope ?? '') === norm(`/${normScope}`));
  const match = exact ?? candidates[0];
  if (!match) return null;
  log.debug(
    {
      assignmentScheduleId: match.properties.roleAssignmentScheduleId,
      principalId: match.properties.principalId,
    },
    'Found active role assignment',
  );
  return {
    roleAssignmentScheduleId: match.properties.roleAssignmentScheduleId,
    principalId: match.properties.principalId,
  };
}

export interface PimClient {
  activate(
    groupId: string,
    principalId: string,
    duration: string,
    justification: string,
  ): Promise<unknown>;
  deactivate(groupId: string, principalId: string): Promise<unknown>;
  listActive(principalId: string): Promise<unknown>;
  activateRbacRole(
    scope: string,
    roleDefinitionId: string,
    principalId: string,
    duration: string,
    justification: string,
  ): Promise<unknown>;
  deactivateRbacRole(
    scope: string,
    roleDefinitionId: string,
    principalId: string,
  ): Promise<unknown>;
}

async function getGraphToken(
  getSecret: (ref: string) => string | undefined,
  log: Logger,
): Promise<string> {
  // Direct token (local dev / test) — never cached
  const directToken = getSecret('AZURE_GRAPH_TOKEN');
  if (directToken) return directToken;

  // Return cached managed identity token if still valid
  if (cachedGraphToken && Date.now() < cachedGraphToken.expiresAtMs) {
    return cachedGraphToken.token;
  }

  // Managed Identity via @azure/identity
  let identityErr: string | undefined;
  try {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
    cachedGraphToken = {
      token: tokenResponse.token,
      expiresAtMs:
        (tokenResponse.expiresOnTimestamp ?? Date.now() + 3600_000) - TOKEN_REFRESH_BUFFER_MS,
    };
    log.debug('Azure Graph managed identity token refreshed');
    return cachedGraphToken.token;
  } catch (err) {
    identityErr = err instanceof Error ? err.message : String(err);
    log.debug(
      { err: identityErr },
      'DefaultAzureCredential failed for Graph, trying az CLI fallback',
    );
  }

  // Azure CLI fallback (az account get-access-token)
  const azResult = await getTokenFromAzCli('https://graph.microsoft.com', log);
  if (azResult) {
    cachedGraphToken = azResult;
    return azResult.token;
  }

  cachedGraphToken = null;
  throw new Error(
    `Azure Graph auth failed — configure AZURE_GRAPH_TOKEN, ensure Managed Identity is available, or log in with 'az login'. Identity error: ${identityErr}`,
  );
}

export function createPimClient(
  getSecret: (ref: string) => string | undefined,
  logger: Logger,
): PimClient {
  const log = logger.child({ component: 'pim-client' });

  return {
    async activate(
      groupId: string,
      principalId: string,
      duration: string,
      justification: string,
    ): Promise<unknown> {
      const token = await getGraphToken(getSecret, log);
      const response = await fetchWithTimeout(PIM_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accessId: 'member',
          principalId,
          groupId,
          action: 'selfActivate',
          scheduleInfo: {
            expiration: {
              type: 'afterDuration',
              duration,
            },
          },
          justification,
        }),
        timeout: 15_000,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`PIM activate failed ${response.status}: ${body.slice(0, 300)}`);
      }

      return readSafeJson(response);
    },

    async deactivate(groupId: string, principalId: string): Promise<unknown> {
      const token = await getGraphToken(getSecret, log);
      const response = await fetchWithTimeout(PIM_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accessId: 'member',
          principalId,
          groupId,
          action: 'selfDeactivate',
        }),
        timeout: 15_000,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`PIM deactivate failed ${response.status}: ${body.slice(0, 300)}`);
      }

      return readSafeJson(response);
    },

    async listActive(principalId: string): Promise<unknown> {
      const token = await getGraphToken(getSecret, log);
      const filter = encodeURIComponent(`principalId eq '${principalId}' and status eq 'Active'`);
      const response = await fetchWithTimeout(`${PIM_SCHEDULES_ENDPOINT}?$filter=${filter}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 15_000,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`PIM list failed ${response.status}: ${body.slice(0, 300)}`);
      }

      const data = (await readSafeJson(response)) as { value?: unknown[] };
      return { activations: data.value ?? [] };
    },

    async activateRbacRole(
      scope: string,
      roleDefinitionId: string,
      principalId: string,
      duration: string,
      justification: string,
    ): Promise<unknown> {
      const token = await getArmToken(getSecret, log);
      // Normalise scope — strip leading slash for URL construction
      const normScope = scope.startsWith('/') ? scope.slice(1) : scope;
      // Derive the subscription ID from the scope to build the full role definition resource ID
      // Scope format: subscriptions/{subId}[/resourceGroups/{rg}[/...]]
      const subMatch = normScope.match(/^subscriptions\/([^/]+)/);
      const subId = subMatch?.[1];
      const fullRoleDefId = subId
        ? `/subscriptions/${subId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`
        : `/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`;

      if (!subId) {
        throw new Error(
          `Cannot derive subscription ID from scope '${scope}' — scope must begin with 'subscriptions/{subId}'.`,
        );
      }

      // Step 1: find eligible assignment (tenant-root URL, asTarget(), no principalId filter)
      // principalId from the result is the real AAD OID — don't trust pod.userId in dev mode.
      const {
        eligibilityScheduleId,
        scope: apiScope,
        principalId: resolvedPrincipalId,
      } = await findEligibilitySchedule(token, fullRoleDefId, normScope, log);

      // Step 2: bail early if already active
      const existing = await findActiveAssignment(token, fullRoleDefId, normScope, log);
      if (existing) {
        log.info(
          { existingAssignmentId: existing.roleAssignmentScheduleId },
          'PIM RBAC role already active — skipping activation',
        );
        return { alreadyActive: true, roleAssignmentScheduleId: existing.roleAssignmentScheduleId };
      }

      // Step 3: activate — use scope from the API result, not from config
      const activationScope = apiScope.startsWith('/') ? apiScope.slice(1) : apiScope;
      const requestName = crypto.randomUUID();
      const url = `${ARM_API}/${activationScope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestName}?api-version=${ARM_RBAC_API_VERSION}`;

      const response = await fetchWithTimeout(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            principalId: resolvedPrincipalId,
            roleDefinitionId: fullRoleDefId,
            linkedRoleEligibilityScheduleId: eligibilityScheduleId,
            requestType: 'SelfActivate',
            justification,
            scheduleInfo: {
              startDateTime: new Date().toISOString(),
              expiration: {
                type: 'AfterDuration',
                duration,
              },
            },
          },
        }),
        timeout: 15_000,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`PIM RBAC role activate failed ${response.status}: ${body.slice(0, 300)}`);
      }

      return readSafeJson(response);
    },

    async deactivateRbacRole(
      scope: string,
      roleDefinitionId: string,
      principalId: string,
    ): Promise<unknown> {
      const token = await getArmToken(getSecret, log);
      const normScope = scope.startsWith('/') ? scope.slice(1) : scope;
      const subMatch = normScope.match(/^subscriptions\/([^/]+)/);
      const subId = subMatch?.[1];
      const fullRoleDefId = subId
        ? `/subscriptions/${subId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`
        : `/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`;

      if (!subId) {
        throw new Error(
          `Cannot derive subscription ID from scope '${scope}' — scope must begin with 'subscriptions/{subId}'.`,
        );
      }

      const activeAssignment = await findActiveAssignment(token, fullRoleDefId, normScope, log);
      if (!activeAssignment) {
        throw new Error(
          `No active PIM role assignment found for role '${fullRoleDefId}' at scope '/${normScope}'. The role may not be currently active.`,
        );
      }
      // Use principalId from API result (real AAD OID) — never trust pod.userId in dev mode.
      const resolvedPrincipalId = activeAssignment.principalId;

      const requestName = crypto.randomUUID();
      const url = `${ARM_API}/${normScope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestName}?api-version=${ARM_RBAC_API_VERSION}`;

      const response = await fetchWithTimeout(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            principalId: resolvedPrincipalId,
            roleDefinitionId: fullRoleDefId,
            linkedRoleAssignmentScheduleId: activeAssignment.roleAssignmentScheduleId,
            requestType: 'SelfDeactivate',
          },
        }),
        timeout: 15_000,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `PIM RBAC role deactivate failed ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      return readSafeJson(response);
    },
  };
}

export function createAzurePimHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret } = config;
  const log = logger.child({ handler: 'azure-pim' });

  return {
    handlerType: 'azure-pim',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      // principal_id and duration are injected by the pod bridge for agent calls,
      // or passed directly from pod-manager for workspace pod auto-activation.
      const client = createPimClient(getSecret, log);

      switch (action.name) {
        case 'activate_pim_group': {
          const groupId = params.group_id as string;
          const principalId = params.principal_id as string;
          const duration = (params.duration as string | undefined) ?? 'PT8H';
          const justification = (params.justification as string | undefined) ?? 'Agent pod access';
          log.debug({ groupId, principalId }, 'Activating PIM group');
          return client.activate(groupId, principalId, duration, justification);
        }

        case 'deactivate_pim_group': {
          const groupId = params.group_id as string;
          const principalId = params.principal_id as string;
          log.debug({ groupId, principalId }, 'Deactivating PIM group');
          return client.deactivate(groupId, principalId);
        }

        case 'list_pim_activations': {
          const principalId = params.principal_id as string;
          log.debug({ principalId }, 'Listing active PIM assignments');
          return client.listActive(principalId);
        }

        case 'activate_pim_role': {
          const scope = params.scope as string;
          const roleDefinitionId = params.role_definition_id as string;
          const principalId = params.principal_id as string;
          const duration = (params.duration as string | undefined) ?? 'PT8H';
          const justification = (params.justification as string | undefined) ?? 'Agent pod access';
          log.debug({ scope, roleDefinitionId, principalId }, 'Activating PIM RBAC role');
          return client.activateRbacRole(
            scope,
            roleDefinitionId,
            principalId,
            duration,
            justification,
          );
        }

        case 'deactivate_pim_role': {
          const scope = params.scope as string;
          const roleDefinitionId = params.role_definition_id as string;
          const principalId = params.principal_id as string;
          log.debug({ scope, roleDefinitionId, principalId }, 'Deactivating PIM RBAC role');
          return client.deactivateRbacRole(scope, roleDefinitionId, principalId);
        }

        default:
          throw new Error(`Unknown azure-pim action: ${action.name}`);
      }
    },
  };
}

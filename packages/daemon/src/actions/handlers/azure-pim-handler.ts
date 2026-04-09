import type { ActionDefinition } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionHandler, HandlerConfig } from './handler.js';
import { fetchWithTimeout, readSafeJson } from './handler.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const PIM_ENDPOINT = `${GRAPH_API}/identityGovernance/privilegedAccess/group/assignmentScheduleRequests`;
const PIM_SCHEDULES_ENDPOINT = `${GRAPH_API}/identityGovernance/privilegedAccess/group/assignmentSchedules`;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cachedGraphToken: CachedToken | null = null;

export interface PimClient {
  activate(
    groupId: string,
    principalId: string,
    duration: string,
    justification: string,
  ): Promise<unknown>;
  deactivate(groupId: string, principalId: string): Promise<unknown>;
  listActive(principalId: string): Promise<unknown>;
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
    cachedGraphToken = null;
    throw new Error(
      `Azure Graph auth failed — configure AZURE_GRAPH_TOKEN or ensure Managed Identity is available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  };
}

export function createAzurePimHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret } = config;
  const log = logger.child({ handler: 'azure-pim' });

  return {
    handlerType: 'azure-pim',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      // principal_id and duration are injected by the session bridge for agent calls,
      // or passed directly from session-manager for workspace pod auto-activation.
      const client = createPimClient(getSecret, log);

      switch (action.name) {
        case 'activate_pim_group': {
          const groupId = params.group_id as string;
          const principalId = params.principal_id as string;
          const duration = (params.duration as string | undefined) ?? 'PT8H';
          const justification =
            (params.justification as string | undefined) ?? 'Agent session access';
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

        default:
          throw new Error(`Unknown azure-pim action: ${action.name}`);
      }
    },
  };
}

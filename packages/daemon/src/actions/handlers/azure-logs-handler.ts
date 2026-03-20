import type { ActionDefinition } from '@autopod/shared';
import type { ActionHandler, HandlerConfig } from './handler.js';
import { fetchWithTimeout } from './handler.js';

const LOG_ANALYTICS_API = 'https://api.loganalytics.io/v1';
const APP_INSIGHTS_API = 'https://api.applicationinsights.io/v1';

export function createAzureLogsHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret } = config;
  const log = logger.child({ handler: 'azure-logs' });

  /**
   * Get bearer token for Azure Monitor APIs.
   * Supports:
   * 1. Explicit token via AZURE_MONITOR_TOKEN env var (for local dev)
   * 2. Managed Identity via Azure Identity SDK (for production on Container Apps)
   */
  async function getToken(): Promise<string> {
    // Direct token (local dev / test)
    const directToken = getSecret('AZURE_MONITOR_TOKEN');
    if (directToken) return directToken;

    // Managed Identity: dynamically import @azure/identity
    try {
      const { DefaultAzureCredential } = await import('@azure/identity');
      const credential = new DefaultAzureCredential();
      const tokenResponse = await credential.getToken('https://api.loganalytics.io/.default');
      return tokenResponse.token;
    } catch (err) {
      throw new Error(`Azure auth failed — configure AZURE_MONITOR_TOKEN or ensure Managed Identity is available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function queryApi(apiBase: string, resourcePath: string, query: string, timespan: string): Promise<unknown> {
    const token = await getToken();

    const response = await fetchWithTimeout(`${apiBase}${resourcePath}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, timespan }),
      timeout: 30_000, // Log queries can be slow
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Azure Monitor ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as { tables: Array<{ name: string; columns: Array<{ name: string }>; rows: unknown[][] }> };

    // Convert tabular format to more readable objects
    return { tables: formatTables(data.tables) };
  }

  return {
    handlerType: 'azure-logs',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      const query = params.query as string;
      const timespan = (params.timespan as string) ?? 'PT1H';

      log.debug({ action: action.name, timespan }, 'Executing Azure Logs action');

      switch (action.name) {
        case 'query_logs': {
          const workspaceId = params.workspace_id as string;
          return queryApi(LOG_ANALYTICS_API, `/workspaces/${workspaceId}`, query, timespan);
        }

        case 'read_app_insights': {
          const appId = params.app_id as string;
          return queryApi(APP_INSIGHTS_API, `/apps/${appId}`, query, timespan);
        }

        case 'read_container_logs': {
          const resourceGroup = params.resource_group as string;
          const containerApp = params.container_app as string;
          const filter = params.filter as string | undefined;

          // Container App logs live in a Log Analytics workspace
          // We construct a KQL query targeting ContainerAppConsoleLogs
          let kql = `ContainerAppConsoleLogs_CL | where ContainerAppName_s == '${containerApp.replace(/'/g, "''")}'`;
          if (filter) kql += ` | ${filter}`;
          kql += ' | order by TimeGenerated desc | take 100';

          // Use the workspace associated with the container app's resource group
          // The caller should provide workspace_id, but we default to searching by resource group
          const workspaceId = (params.workspace_id as string) ?? resourceGroup;
          return queryApi(LOG_ANALYTICS_API, `/workspaces/${workspaceId}`, kql, timespan);
        }

        default:
          throw new Error(`Unknown Azure Logs action: ${action.name}`);
      }
    },
  };
}

/**
 * Convert Azure Monitor tabular response (columns + rows) to array of objects.
 * This makes the data much more usable for agents.
 */
function formatTables(
  tables: Array<{ name: string; columns: Array<{ name: string }>; rows: unknown[][] }>,
): Array<{ name: string; rows: Record<string, unknown>[] }> {
  return tables.map((table) => ({
    name: table.name,
    rows: table.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < table.columns.length; i++) {
        const col = table.columns[i];
        if (col) obj[col.name] = row[i];
      }
      return obj;
    }),
  }));
}

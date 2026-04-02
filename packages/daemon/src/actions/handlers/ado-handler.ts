import type { ActionDefinition } from '@autopod/shared';
import type { ActionHandler, HandlerConfig } from './handler.js';
import { fetchWithTimeout, pickFields, pickFieldsArray, readSafeJson } from './handler.js';

const ADO_API_VERSION = '7.1';

export function createAdoHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret } = config;
  const log = logger.child({ handler: 'ado' });

  function getAuth(): string {
    const pat = getSecret('ADO_PAT') ?? getSecret('ado-pat');
    if (!pat) throw new Error('Azure DevOps PAT not configured (ADO_PAT or ado-pat)');
    return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }

  async function adoFetch(url: string): Promise<unknown> {
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: getAuth(),
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ADO API ${response.status}: ${body.slice(0, 200)}`);
    }

    return readSafeJson(response);
  }

  async function adoPost(url: string, body: unknown): Promise<unknown> {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: getAuth(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeout: 15_000,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ADO API ${response.status}: ${text.slice(0, 200)}`);
    }

    return readSafeJson(response);
  }

  return {
    handlerType: 'ado',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      const org = params.org as string;
      const project = params.project as string;

      log.debug({ action: action.name, org, project }, 'Executing ADO action');

      switch (action.name) {
        case 'read_workitem': {
          const workitemId = params.workitem_id as number;
          const data = await adoFetch(
            `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workitemId}?$expand=all&api-version=${ADO_API_VERSION}`,
          );
          return pickFields(data, action.response.fields);
        }

        case 'search_workitems': {
          const max = (params.max_results as number) ?? 10;
          const query = params.query as string;
          const state = params.state as string | undefined;
          const type = params.type as string | undefined;

          const escapedProject = project.replace(/'/g, "''");

          // Build WIQL query
          let wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.TeamProject] = '${escapedProject}'`;

          // If the query looks like a raw WIQL fragment, append it as an AND clause
          // rather than replacing the whole query — this preserves the project scope filter.
          if (query.toUpperCase().includes('WHERE') || query.startsWith('[')) {
            log.warn(
              { org, project },
              'Raw WIQL fragment detected — appending project scope filter',
            );
            wiql += ` AND (${query})`;
          } else {
            wiql += ` AND [System.Title] CONTAINS '${query.replace(/'/g, "''")}'`;
          }

          if (state) wiql += ` AND [System.State] = '${state.replace(/'/g, "''")}'`;
          if (type) wiql += ` AND [System.WorkItemType] = '${type.replace(/'/g, "''")}'`;
          wiql += ' ORDER BY [System.ChangedDate] DESC';

          const wiqlResult = (await adoPost(
            `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=${ADO_API_VERSION}&$top=${max}`,
            { query: wiql },
          )) as { workItems: Array<{ id: number }> };

          if (!wiqlResult.workItems?.length) return [];

          // Batch-fetch the work items
          const ids = wiqlResult.workItems.slice(0, max).map((wi) => wi.id);
          const batchResult = (await adoFetch(
            `https://dev.azure.com/${org}/${project}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=${ADO_API_VERSION}`,
          )) as { value: unknown[] };

          return pickFieldsArray(batchResult.value ?? [], action.response.fields);
        }

        default:
          throw new Error(`Unknown ADO action: ${action.name}`);
      }
    },
  };
}

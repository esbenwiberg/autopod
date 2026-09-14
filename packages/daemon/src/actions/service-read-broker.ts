import {
  type ServiceAccessRule,
  type ServiceReadRequest,
  serviceReadSchema,
} from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';

export interface ServiceReadTransport {
  request(
    service: ServiceAccessRule['service'],
    url: string,
    body: unknown | undefined,
    assertAuthorized: () => void,
  ): Promise<unknown>;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const values = (value: unknown): unknown[] =>
  Array.isArray(record(value).value) ? (record(value).value as unknown[]) : [];
const equal = (left: unknown, right: string) =>
  typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const missing = (field: string): never =>
  configurationError(`This operation requires ${field}`, 'SERVICE_READ_INPUT_INVALID', 400);
const kqlString = (value: string) => JSON.stringify(value);

/** Agent input selects one complete saved rule; scopes are never combined across rules. */
export async function readScopedService(input: {
  raw: unknown;
  rules: readonly ServiceAccessRule[];
  transport: ServiceReadTransport;
  assertAuthorized(): void;
}): Promise<unknown> {
  const request = serviceReadSchema.parse(input.raw);
  const rule = input.rules.find((r) => r.id === request.ruleId && r.service === request.service);
  if (!rule)
    configurationError('Service access rule is not selected', 'SERVICE_ACCESS_DENIED', 403);
  const call = async (url: string, body?: unknown) => {
    input.assertAuthorized();
    const result = await input.transport.request(rule.service, url, body, input.assertAuthorized);
    input.assertAuthorized();
    return result;
  };
  if (rule.service === 'azure-logs' && request.service === 'azure-logs') {
    if (!rule.tables.includes(request.table))
      configurationError('Log table is outside the selected rule', 'SERVICE_ACCESS_DENIED', 403);
    let query: string = request.table;
    if (rule.containerApp)
      query += ` | where ContainerAppName_s == ${kqlString(rule.containerApp)}`;
    if (request.contains)
      query += ` | where tostring(pack_all()) contains ${kqlString(request.contains)}`;
    query += ` | order by TimeGenerated desc | take ${request.limit}`;
    return call(`https://api.loganalytics.io/v1/workspaces/${rule.workspaceId}/query`, {
      query,
      timespan: request.timespan,
    });
  }
  if (
    rule.service !== 'ado' ||
    request.service !== 'ado' ||
    !rule.operations.includes(request.operation)
  )
    configurationError('Operation is outside the selected rule', 'SERVICE_ACCESS_DENIED', 403);
  return readAdo(rule, request, call);
}

async function readAdo(
  rule: Extract<ServiceAccessRule, { service: 'ado' }>,
  request: Extract<ServiceReadRequest, { service: 'ado' }>,
  call: (url: string, body?: unknown) => Promise<unknown>,
) {
  const base = `https://dev.azure.com/${encodeURIComponent(rule.organization)}/${encodeURIComponent(rule.project)}/_apis`;
  const repo = `${base}/git/repositories/${encodeURIComponent(rule.repository ?? '')}`;
  const url = (path: string, query: Record<string, string> = {}) =>
    `${path}?${new URLSearchParams({ 'api-version': '7.1', ...query })}`;
  const itemId = () => request.itemId ?? missing('itemId');
  const search = () => request.query ?? missing('query');
  const projectItem = (item: unknown) => {
    if (!equal(record(record(item).fields)['System.TeamProject'], rule.project))
      configurationError(
        'Provider returned a work item outside the selected project',
        'SERVICE_RESPONSE_SCOPE_MISMATCH',
        502,
      );
    return item;
  };
  switch (request.operation) {
    case 'code.file':
      return call(
        url(`${repo}/items`, {
          path: request.path ?? missing('path'),
          includeContent: 'true',
          resolveLfs: 'false',
          ...(request.ref
            ? {
                'versionDescriptor.version': request.ref,
                'versionDescriptor.versionType': 'branch',
              }
            : {}),
        }),
      );
    case 'code.search': {
      const result = await call(
        `https://almsearch.dev.azure.com/${encodeURIComponent(rule.organization)}/${encodeURIComponent(rule.project)}/_apis/search/codesearchresults?api-version=7.1`,
        {
          searchText: search(),
          $top: request.limit,
          $skip: 0,
          filters: { Project: [rule.project], Repository: [rule.repository] },
          includeFacets: false,
        },
      );
      const items = record(result).results;
      if (
        !Array.isArray(items) ||
        items.some(
          (item) =>
            !equal(record(record(item).project).name, rule.project) ||
            !equal(record(record(item).repository).name, rule.repository ?? ''),
        )
      )
        configurationError(
          'Provider returned search results outside the selected repository',
          'SERVICE_RESPONSE_SCOPE_MISMATCH',
          502,
        );
      return { results: items.slice(0, request.limit) };
    }
    case 'pr.read':
      return call(url(`${repo}/pullrequests/${itemId()}`));
    case 'pr.threads':
      return call(url(`${repo}/pullrequests/${itemId()}/threads`));
    case 'pr.changes': {
      const iterations = values(await call(url(`${repo}/pullrequests/${itemId()}/iterations`)));
      const ids = iterations
        .map((item) => record(item).id)
        .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
      if (!ids.length) return { changeEntries: [] };
      return call(
        url(`${repo}/pullrequests/${itemId()}/iterations/${Math.max(...ids)}/changes`, {
          $top: String(request.limit),
        }),
      );
    }
    case 'workitem.read':
      return projectItem(await call(url(`${base}/wit/workitems/${itemId()}`, { $expand: 'all' })));
    case 'workitem.search': {
      const wiqlLiteral = (s: string) => s.replace(/'/g, "''");
      const found = valuesFromWorkItems(
        await call(url(`${base}/wit/wiql`, { $top: String(request.limit) }), {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlLiteral(rule.project)}' AND [System.Title] CONTAINS '${wiqlLiteral(search())}' ORDER BY [System.ChangedDate] DESC`,
        }),
      );
      if (!found.length) return [];
      const result = await call(
        url(`${base}/wit/workitems`, {
          ids: found.slice(0, request.limit).join(','),
          $expand: 'all',
        }),
      );
      return values(result).map(projectItem);
    }
  }
}
function valuesFromWorkItems(value: unknown): number[] {
  const items = record(value).workItems;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => record(item).id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
}

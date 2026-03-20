import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createAzureLogsHandler } from './azure-logs-handler.js';

function mockResponse(
  data: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
}

const logger = pino({ level: 'silent' });

function makeAction(name: string, fields: string[] = []): any {
  return {
    name,
    description: '',
    group: {} as any,
    handler: {} as any,
    params: {},
    response: { fields },
  };
}

function makeTableResponse(
  columns: string[],
  rows: unknown[][],
  tableName = 'PrimaryResult',
) {
  return {
    tables: [
      {
        name: tableName,
        columns: columns.map((name) => ({ name })),
        rows,
      },
    ],
  };
}

describe('createAzureLogsHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses AZURE_MONITOR_TOKEN when available', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse(['Count'], [[42]])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'bearer-token-123' : undefined),
    });

    await handler.execute(makeAction('query_logs'), {
      workspace_id: 'ws-abc',
      query: 'AzureActivity | take 10',
    });

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const authHeader = (calledOpts.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer bearer-token-123');
  });

  it('query_logs calls correct URL with query and default timespan PT1H', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse(['Count'], [[42]])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('query_logs'), {
      workspace_id: 'ws-123',
      query: 'Heartbeat | count',
    });

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.loganalytics.io/v1/workspaces/ws-123/query');

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.query).toBe('Heartbeat | count');
    expect(bodyParsed.timespan).toBe('PT1H');
  });

  it('query_logs uses custom timespan when provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse([], [])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('query_logs'), {
      workspace_id: 'ws-123',
      query: 'Heartbeat | count',
      timespan: 'PT24H',
    });

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.timespan).toBe('PT24H');
  });

  it('read_app_insights calls correct URL', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse([], [])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('read_app_insights'), {
      app_id: 'app-xyz',
      query: 'requests | take 5',
    });

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.applicationinsights.io/v1/apps/app-xyz/query');
  });

  it('read_container_logs builds KQL query with single-quote escaping', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse([], [])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('read_container_logs'), {
      workspace_id: 'ws-123',
      resource_group: 'rg-test',
      container_app: "my-app's-service",
    });

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.query).toContain('ContainerAppConsoleLogs');
    expect(bodyParsed.query).toContain("my-app''s-service");
    expect(bodyParsed.query).not.toContain("my-app's-service");
  });

  it('formatTables converts tabular response to named tables with row objects', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse(['Name', 'Value'], [['alpha', 1], ['beta', 2]])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    const result: any = await handler.execute(makeAction('query_logs'), {
      workspace_id: 'ws-123',
      query: 'MyTable',
    });

    // queryApi returns { tables: formatTables(data.tables) }
    expect(result.tables).toBeDefined();
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe('PrimaryResult');
    expect(result.tables[0].rows).toEqual([
      { Name: 'alpha', Value: 1 },
      { Name: 'beta', Value: 2 },
    ]);
  });

  it('formatTables handles empty tables', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(makeTableResponse(['Id'], [])),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    const result: any = await handler.execute(makeAction('query_logs'), {
      workspace_id: 'ws-123',
      query: 'EmptyTable',
    });

    expect(result.tables).toBeDefined();
    expect(result.tables[0].rows).toEqual([]);
  });

  it('throws on HTTP error', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ error: { message: 'Bad request' } }, { status: 400 }),
    );

    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await expect(
      handler.execute(makeAction('query_logs'), {
        workspace_id: 'ws-123',
        query: 'invalid ||| query',
      }),
    ).rejects.toThrow(/400/);
  });

  it('throws on unknown action', async () => {
    const handler = createAzureLogsHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_MONITOR_TOKEN' ? 'token' : undefined),
    });

    await expect(
      handler.execute(makeAction('drop_database'), { workspace_id: 'ws-123' }),
    ).rejects.toThrow(/unknown/i);
  });
});

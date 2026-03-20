import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createAdoHandler } from './ado-handler.js';

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

describe('createAdoHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws during execute when no PAT is available', async () => {
    const handler = createAdoHandler({ logger, getSecret: () => undefined });

    await expect(
      handler.execute(makeAction('read_workitem'), {
        org: 'myorg',
        project: 'myproject',
        workitem_id: 1,
      }),
    ).rejects.toThrow(/pat/i);
  });

  it('returns a handler with handlerType "ado"', () => {
    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });
    expect(handler.handlerType).toBe('ado');
  });

  it('accepts token from ado-pat fallback', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ id: 1, fields: { 'System.Title': 'Test' } }),
    );

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ado-pat' ? 'ado-fallback' : undefined),
    });

    await handler.execute(makeAction('read_workitem'), {
      org: 'myorg',
      project: 'myproject',
      workitem_id: 1,
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('read_workitem calls correct URL with Basic auth and picks fields', async () => {
    const workitemData = {
      id: 123,
      fields: {
        'System.Title': 'Fix the bug',
        'System.State': 'Active',
      },
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(workitemData));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('read_workitem', ['id', 'fields.System.Title']),
      { org: 'myorg', project: 'myproject', workitem_id: 123 },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      'https://dev.azure.com/myorg/myproject/_apis/wit/workitems/123?$expand=all&api-version=7.1',
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const authHeader = (calledOpts.headers as Record<string, string>)['Authorization'];
    const expectedAuth = `Basic ${Buffer.from(':ado-token').toString('base64')}`;
    expect(authHeader).toBe(expectedAuth);

    expect(result).toEqual(
      expect.objectContaining({ id: 123 }),
    );
  });

  it('search_workitems builds auto-generated WIQL query and picks fields from batch', async () => {
    // First call: WIQL query returns IDs
    const wiqlResponse = { workItems: [{ id: 1 }, { id: 2 }] };
    // Second call: batch fetch returns details
    const batchResponse = {
      value: [
        { id: 1, fields: { 'System.Title': 'Item 1' } },
        { id: 2, fields: { 'System.Title': 'Item 2' } },
      ],
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockResponse(wiqlResponse))
      .mockResolvedValueOnce(mockResponse(batchResponse));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result: any = await handler.execute(
      makeAction('search_workitems', ['id']),
      { org: 'myorg', project: 'myproject', query: 'login bug' },
    );

    // Check WIQL body
    const firstCallOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(firstCallOpts.body as string);
    expect(bodyParsed.query).toContain("[System.TeamProject] = 'myproject'");
    expect(bodyParsed.query).toContain("[System.Title] CONTAINS 'login bug'");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('search_workitems uses raw WIQL when query includes WHERE', async () => {
    const wiqlResponse = { workItems: [{ id: 5 }] };
    const batchResponse = {
      value: [{ id: 5, fields: { 'System.Title': 'Raw result' } }],
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockResponse(wiqlResponse))
      .mockResolvedValueOnce(mockResponse(batchResponse));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const rawQuery = "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'";
    await handler.execute(makeAction('search_workitems'), {
      org: 'myorg',
      project: 'myproject',
      query: rawQuery,
    });

    const firstCallOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(firstCallOpts.body as string);
    // Raw query is used but state/type + ORDER BY are still appended
    expect(bodyParsed.query).toContain("WHERE [System.State] = 'Active'");
    expect(bodyParsed.query).toContain('ORDER BY');
  });

  it('search_workitems escapes single quotes in query, state, and type', async () => {
    const wiqlResponse = { workItems: [] };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(wiqlResponse));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    await handler.execute(makeAction('search_workitems'), {
      org: 'myorg',
      project: 'myproject',
      query: "can't reproduce",
      state: "Won't Fix",
      type: "User's Story",
    });

    const firstCallOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(firstCallOpts.body as string);
    expect(bodyParsed.query).toContain("can''t reproduce");
    expect(bodyParsed.query).toContain("Won''t Fix");
    expect(bodyParsed.query).toContain("User''s Story");
  });

  it('search_workitems returns empty array for no results', async () => {
    const wiqlResponse = { workItems: [] };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(wiqlResponse));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(makeAction('search_workitems'), {
      org: 'myorg',
      project: 'myproject',
      query: 'nothing here',
    });

    expect(result).toEqual([]);
  });

  it('throws on HTTP error with status', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ message: 'Unauthorized' }, { status: 401 }),
    );

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    await expect(
      handler.execute(makeAction('read_workitem'), {
        org: 'myorg',
        project: 'myproject',
        workitem_id: 1,
      }),
    ).rejects.toThrow(/401/);
  });

  it('throws on unknown action', async () => {
    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    await expect(
      handler.execute(makeAction('delete_everything'), {
        org: 'myorg',
        project: 'myproject',
      }),
    ).rejects.toThrow(/unknown/i);
  });
});

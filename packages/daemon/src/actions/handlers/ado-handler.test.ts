import type { ActionDefinition } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeAction(name: string, fields: string[] = []): ActionDefinition {
  return {
    name,
    description: '',
    group: 'ado',
    handler: 'ado',
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
    const authHeader = (calledOpts.headers as Record<string, string>).Authorization;
    const expectedAuth = `Basic ${Buffer.from(':ado-token').toString('base64')}`;
    expect(authHeader).toBe(expectedAuth);

    expect(result).toEqual(expect.objectContaining({ id: 123 }));
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

    const result = await handler.execute(makeAction('search_workitems', ['id']), {
      org: 'myorg',
      project: 'myproject',
      query: 'login bug',
    });

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

  // ── PR actions ──────────────────────────────────────────────────

  it('ado_read_pr calls correct URL and picks fields', async () => {
    const prData = {
      pullRequestId: 42,
      title: 'Add feature X',
      description: 'Implements feature X',
      status: 'active',
      sourceRefName: 'refs/heads/feature-x',
      targetRefName: 'refs/heads/main',
      createdBy: { displayName: 'Test User' },
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(prData));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('ado_read_pr', ['pullRequestId', 'title', 'status']),
      { org: 'myorg', project: 'myproject', repo: 'myrepo', pull_request_id: 42 },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests/42?api-version=7.1',
    );
    expect(result).toEqual(expect.objectContaining({ pullRequestId: 42, title: 'Add feature X' }));
  });

  it('ado_read_pr_threads filters system threads and respects max_results', async () => {
    const threadsData = {
      value: [
        {
          id: 1,
          status: 'active',
          comments: [{ content: 'Please fix this', commentType: 'text', publishedDate: '2025-01-01' }],
        },
        {
          id: 2,
          status: 'closed',
          comments: [{ content: 'Build succeeded', commentType: 'system', publishedDate: '2025-01-01' }],
        },
        {
          id: 3,
          status: 'active',
          comments: [{ content: 'LGTM', commentType: 'text', publishedDate: '2025-01-02' }],
        },
      ],
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(threadsData));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('ado_read_pr_threads', ['id', 'status']),
      { org: 'myorg', project: 'myproject', repo: 'myrepo', pull_request_id: 10, max_results: 1 },
    );

    // Should filter out system thread (id: 2) and limit to max_results=1
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('ado_read_pr_changes fetches iterations then last iteration changes', async () => {
    const iterationsData = { value: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const changesData = {
      changeEntries: [
        { item: { path: '/src/index.ts', gitObjectType: 'blob' }, changeType: 'edit' },
        { item: { path: '/src/utils.ts', gitObjectType: 'blob' }, changeType: 'add' },
      ],
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockResponse(iterationsData))
      .mockResolvedValueOnce(mockResponse(changesData));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('ado_read_pr_changes', ['changeEntries.item.path', 'changeEntries.changeType']),
      { org: 'myorg', project: 'myproject', repo: 'myrepo', pull_request_id: 5 },
    );

    // Verify iterations URL
    const firstUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(firstUrl).toContain('/pullrequests/5/iterations');

    // Verify changes URL uses last iteration (id: 3)
    const secondUrl = vi.mocked(global.fetch).mock.calls[1][0] as string;
    expect(secondUrl).toContain('/iterations/3/changes');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('ado_read_pr_changes returns empty for no iterations', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ value: [] }));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(makeAction('ado_read_pr_changes'), {
      org: 'myorg',
      project: 'myproject',
      repo: 'myrepo',
      pull_request_id: 5,
    });

    expect(result).toEqual([]);
    // Should only make one call (iterations), not a second call for changes
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // ── Code actions ────────────────────────────────────────────────

  it('ado_read_file calls correct URL with path and picks fields', async () => {
    const fileData = {
      content: 'console.log("hello");',
      path: '/src/index.ts',
      objectId: 'abc123',
      commitId: 'def456',
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(fileData));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('ado_read_file', ['content', 'path']),
      { org: 'myorg', project: 'myproject', repo: 'myrepo', path: '/src/index.ts' },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('includeContent=true');
    expect(calledUrl).toContain('path=%2Fsrc%2Findex.ts');
    expect(calledUrl).not.toContain('versionDescriptor');
    expect(result).toEqual(expect.objectContaining({ content: 'console.log("hello");' }));
  });

  it('ado_read_file includes version descriptor when version is provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ content: 'old code', path: '/src/index.ts' }),
    );

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    await handler.execute(makeAction('ado_read_file', ['content']), {
      org: 'myorg',
      project: 'myproject',
      repo: 'myrepo',
      path: '/src/index.ts',
      version: 'feature-branch',
    });

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('versionDescriptor.version=feature-branch');
  });

  it('ado_search_code posts to almsearch.dev.azure.com with correct body', async () => {
    const searchResults = {
      results: [
        { fileName: 'index.ts', path: '/src/index.ts', repository: { name: 'myrepo' } },
      ],
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(searchResults));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(
      makeAction('ado_search_code', ['fileName', 'path']),
      { org: 'myorg', project: 'myproject', query: 'TODO', max_results: 5 },
    );

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      'https://almsearch.dev.azure.com/myorg/myproject/_apis/search/codesearchresults?api-version=7.1',
    );

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.searchText).toBe('TODO');
    expect(bodyParsed.$top).toBe(5);
    expect(bodyParsed.filters.Project).toEqual(['myproject']);
    expect(bodyParsed.filters.Repository).toBeUndefined();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('ado_search_code includes repo filter when repo is provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ results: [] }));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    await handler.execute(makeAction('ado_search_code', ['fileName']), {
      org: 'myorg',
      project: 'myproject',
      query: 'function',
      repo: 'specific-repo',
    });

    const calledOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const bodyParsed = JSON.parse(calledOpts.body as string);
    expect(bodyParsed.filters.Repository).toEqual(['specific-repo']);
  });

  it('ado_search_code returns empty array for no results', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ results: [] }));

    const handler = createAdoHandler({
      logger,
      getSecret: (ref) => (ref === 'ADO_PAT' ? 'ado-token' : undefined),
    });

    const result = await handler.execute(makeAction('ado_search_code', ['fileName']), {
      org: 'myorg',
      project: 'myproject',
      query: 'nonexistent',
    });

    expect(result).toEqual([]);
  });
});

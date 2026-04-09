import type { ActionDefinition } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAzurePimHandler, createPimClient } from './azure-pim-handler.js';

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

function makeAction(name: string): ActionDefinition {
  return {
    name,
    description: '',
    group: 'azure-pim',
    handler: 'azure-pim',
    params: {},
    response: { fields: [] },
  };
}

describe('createPimClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('activate sends correct Graph API request body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ id: 'req-1', status: 'Provisioned' }),
    );

    const client = createPimClient(
      (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'graph-token' : undefined),
      logger,
    );

    await client.activate('group-uuid-1', 'principal-uuid-1', 'PT4H', 'Testing workspace');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('assignmentScheduleRequests');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer graph-token');

    const body = JSON.parse(opts.body as string);
    expect(body.accessId).toBe('member');
    expect(body.principalId).toBe('principal-uuid-1');
    expect(body.groupId).toBe('group-uuid-1');
    expect(body.action).toBe('selfActivate');
    expect(body.scheduleInfo.expiration.type).toBe('afterDuration');
    expect(body.scheduleInfo.expiration.duration).toBe('PT4H');
    expect(body.justification).toBe('Testing workspace');
  });

  it('deactivate sends selfDeactivate action', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ id: 'req-2', status: 'Revoked' }));

    const client = createPimClient(
      (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'graph-token' : undefined),
      logger,
    );

    await client.deactivate('group-uuid-1', 'principal-uuid-1');

    const [, opts] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.action).toBe('selfDeactivate');
    expect(body.groupId).toBe('group-uuid-1');
    expect(body.principalId).toBe('principal-uuid-1');
  });

  it('listActive queries assignmentSchedules with filter', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ value: [{ id: 'sched-1', groupId: 'g1' }] }),
    );

    const client = createPimClient(
      (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'graph-token' : undefined),
      logger,
    );

    const result = await client.listActive('principal-uuid-1');

    const [url] = vi.mocked(global.fetch).mock.calls[0] as [string];
    expect(url).toContain('assignmentSchedules');
    expect(url).toContain(encodeURIComponent("principalId eq 'principal-uuid-1'"));
    expect((result as { activations: unknown[] }).activations).toHaveLength(1);
  });

  it('throws on HTTP error', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ error: { message: 'Forbidden' } }, { status: 403 }),
    );

    const client = createPimClient(
      (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'graph-token' : undefined),
      logger,
    );

    await expect(
      client.activate('group-uuid-1', 'principal-uuid-1', 'PT8H', 'test'),
    ).rejects.toThrow(/403/);
  });
});

describe('createAzurePimHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('dispatches activate_pim_group to client.activate', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ id: 'req-1', status: 'Provisioned' }),
    );

    const handler = createAzurePimHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('activate_pim_group'), {
      group_id: 'g1',
      principal_id: 'p1',
      duration: 'PT2H',
      justification: 'Need access',
    });

    const [, opts] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.action).toBe('selfActivate');
    expect(body.groupId).toBe('g1');
  });

  it('dispatches deactivate_pim_group to client.deactivate', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ id: 'req-2', status: 'Revoked' }));

    const handler = createAzurePimHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('deactivate_pim_group'), {
      group_id: 'g1',
      principal_id: 'p1',
    });

    const [, opts] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.action).toBe('selfDeactivate');
  });

  it('dispatches list_pim_activations to client.listActive', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ value: [] }));

    const handler = createAzurePimHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'token' : undefined),
    });

    const result = await handler.execute(makeAction('list_pim_activations'), {
      principal_id: 'p1',
    });

    expect((result as { activations: unknown[] }).activations).toEqual([]);
  });

  it('throws on unknown action name', async () => {
    const handler = createAzurePimHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'token' : undefined),
    });

    await expect(handler.execute(makeAction('unknown_action'), {})).rejects.toThrow(/unknown/i);
  });

  it('uses default duration PT8H when not provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ id: 'req-1', status: 'Provisioned' }),
    );

    const handler = createAzurePimHandler({
      logger,
      getSecret: (ref) => (ref === 'AZURE_GRAPH_TOKEN' ? 'token' : undefined),
    });

    await handler.execute(makeAction('activate_pim_group'), {
      group_id: 'g1',
      principal_id: 'p1',
    });

    const [, opts] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.scheduleInfo.expiration.duration).toBe('PT8H');
  });
});

import type { ActionDefinition } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAzureTokenCache } from '../../providers/azure-token.js';
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

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function mockAzCliToken(token = 'az-arm-token') {
  const execFile = vi.fn(
    (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, {
        stdout: JSON.stringify({
          accessToken: token,
          expiresOn: new Date(Date.now() + 3600_000).toISOString(),
        }),
        stderr: '',
      });
    },
  );
  vi.doMock('node:child_process', () => ({ execFile }));
  return execFile;
}

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
    clearAzureTokenCache();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock('@azure/identity');
    vi.doUnmock('node:child_process');
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

  it('prefers az CLI for RBAC role activation when no explicit ARM token is configured', async () => {
    const roleDefinitionId = '73c42c96-874c-492b-b04d-ab87d138a893';
    const fullRoleDefinitionId = `/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`;
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              properties: {
                principalId: 'real-aad-principal',
                roleDefinitionId: fullRoleDefinitionId,
                scope: '/subscriptions/sub-1/resourceGroups/rg-logs',
                roleEligibilityScheduleId: 'eligibility-1',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockResponse({ value: [] }))
      .mockResolvedValueOnce(
        mockResponse({ name: 'activation-1', properties: { status: 'Accepted' } }),
      );
    const getToken = vi.fn().mockResolvedValue({
      token: 'managed-identity-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });
    vi.doMock('@azure/identity', () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires regular functions for class mocks
      DefaultAzureCredential: vi.fn().mockImplementation(function () {
        return { getToken };
      }),
    }));
    const execFile = mockAzCliToken();

    const client = createPimClient(() => undefined, logger);

    await client.activateRbacRole(
      '/subscriptions/sub-1/resourceGroups/rg-logs',
      roleDefinitionId,
      'ignored-by-rbac-path',
      'PT1H',
      'test activation',
    );

    expect(getToken).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        'https://management.azure.com',
        '--output',
        'json',
      ],
      expect.any(Object),
      expect.any(Function),
    );
    const firstFetchOpts = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect((firstFetchOpts.headers as Record<string, string>).Authorization).toBe(
      'Bearer az-arm-token',
    );
  });
});

describe('createAzurePimHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearAzureTokenCache();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock('@azure/identity');
    vi.doUnmock('node:child_process');
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

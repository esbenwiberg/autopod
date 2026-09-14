import { serviceAccessSchema } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { type ServiceReadTransport, readScopedService } from './service-read-broker.js';
import { createServiceReadTransport } from './service-read-transport.js';

const rules = serviceAccessSchema.parse([
  {
    id: 'source',
    service: 'ado',
    organization: 'company',
    project: 'Project One',
    repository: 'source',
    operations: [
      'code.file',
      'code.search',
      'pr.read',
      'pr.threads',
      'pr.changes',
      'workitem.read',
      'workitem.search',
    ],
  },
  {
    id: 'other',
    service: 'ado',
    organization: 'company',
    project: 'Other',
    repository: 'other',
    operations: ['code.file'],
  },
  {
    id: 'logs',
    service: 'azure-logs',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    tables: ['ContainerAppConsoleLogs_CL'],
    containerApp: 'selected-app',
  },
]);
function fixture() {
  const request = vi.fn<ServiceReadTransport['request']>(async () => ({}) as unknown);
  const assertAuthorized = vi.fn();
  return {
    request,
    assertAuthorized,
    run: (raw: unknown) =>
      readScopedService({ raw, rules, transport: { request }, assertAuthorized }),
  };
}
describe('scoped service reads', () => {
  it('cannot borrow operations or override destinations from another rule', async () => {
    const f = fixture();
    await expect(
      f.run({ service: 'ado', ruleId: 'other', operation: 'pr.read', itemId: 1 }),
    ).rejects.toThrow('outside');
    await expect(
      f.run({
        service: 'ado',
        ruleId: 'source',
        operation: 'code.file',
        path: '/a',
        organization: 'elsewhere',
      }),
    ).rejects.toThrow();
    await expect(f.run({ service: 'ado', ruleId: 'source', operation: 'push' })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('encodes source paths and refs as query values, never endpoints', async () => {
    const f = fixture();
    await f.run({
      service: 'ado',
      ruleId: 'source',
      operation: 'code.file',
      path: '/a?scope=other',
      ref: 'main&other=x',
    });
    const url = new URL(String(f.request.mock.calls[0]?.[1]));
    expect(url.pathname).toBe('/company/Project%20One/_apis/git/repositories/source/items');
    expect(url.searchParams.get('path')).toBe('/a?scope=other');
    expect(url.searchParams.get('versionDescriptor.version')).toBe('main&other=x');
    expect(url.searchParams.has('other')).toBe(false);
  });
  it('rejects cross-project work items even when the API returns them', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ fields: { 'System.TeamProject': 'Other' } });
    await expect(
      f.run({ service: 'ado', ruleId: 'source', operation: 'workitem.read', itemId: 1 }),
    ).rejects.toThrow('outside');
  });
  it('verifies code search response scope as well as request filters', async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      results: [{ project: { name: 'Project One' }, repository: { name: 'other' } }],
    });
    await expect(
      f.run({ service: 'ado', ruleId: 'source', operation: 'code.search', query: 'repo:other' }),
    ).rejects.toThrow('outside');
    expect(f.request).toHaveBeenCalledWith(
      'ado',
      expect.stringContaining('almsearch.dev.azure.com'),
      expect.objectContaining({ filters: { Project: ['Project One'], Repository: ['source'] } }),
      expect.any(Function),
    );
  });
  it('treats WIQL syntax as a title search literal', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ workItems: [] });
    await f.run({
      service: 'ado',
      ruleId: 'source',
      operation: 'workitem.search',
      query: "x' OR [System.TeamProject] = 'Other",
    });
    expect(f.request).toHaveBeenCalledWith(
      'ado',
      expect.any(String),
      {
        query:
          "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Project One' AND [System.Title] CONTAINS 'x'' OR [System.TeamProject] = ''Other' ORDER BY [System.ChangedDate] DESC",
      },
      expect.any(Function),
    );
  });
  it('uses fixed log queries and escapes literal filters', async () => {
    const f = fixture();
    const contains = 'x" | union workspace("other").traces | //';
    await f.run({
      service: 'azure-logs',
      ruleId: 'logs',
      table: 'ContainerAppConsoleLogs_CL',
      contains,
    });
    expect(f.request).toHaveBeenCalledWith(
      'azure-logs',
      expect.stringContaining('/11111111-1111-4111-8111-111111111111/query'),
      {
        timespan: 'PT1H',
        query: `ContainerAppConsoleLogs_CL | where ContainerAppName_s == "selected-app" | where tostring(pack_all()) contains ${JSON.stringify(contains)} | order by TimeGenerated desc | take 30`,
      },
      expect.any(Function),
    );
    await expect(
      f.run({ service: 'azure-logs', ruleId: 'logs', table: 'AppTraces' }),
    ).rejects.toThrow('outside');
    await expect(
      f.run({
        service: 'azure-logs',
        ruleId: 'logs',
        table: 'ContainerAppConsoleLogs_CL',
        query: 'union *',
      }),
    ).rejects.toThrow();
  });
  it('checks cancellation before request and before returning results', async () => {
    const f = fixture();
    f.assertAuthorized.mockImplementationOnce(() => {
      throw new Error('cancelled');
    });
    await expect(
      f.run({ service: 'ado', ruleId: 'source', operation: 'pr.read', itemId: 1 }),
    ).rejects.toThrow('cancelled');
    expect(f.request).not.toHaveBeenCalled();
    f.assertAuthorized
      .mockReset()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('revoked');
      });
    await expect(
      f.run({ service: 'ado', ruleId: 'source', operation: 'pr.read', itemId: 1 }),
    ).rejects.toThrow('revoked');
  });
});
describe('service credential transport', () => {
  it('rejects wrong origins before credentials and refuses redirects', async () => {
    const token = vi.fn(async () => 'fixture');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const transport = createServiceReadTransport({ ado: token, logs: token }, fetcher);
    await expect(
      transport.request('ado', 'https://dev.azure.com.evil.test/x', undefined, () => {}),
    ).rejects.toThrow('origin');
    expect(token).not.toHaveBeenCalled();
    await transport.request(
      'ado',
      'https://dev.azure.com/org/project/_apis/example',
      undefined,
      () => {},
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error', method: 'GET' }),
    );
  });
  it('checks revocation again after credential acquisition', async () => {
    const fetcher = vi.fn<typeof fetch>();
    let revoked = false;
    const transport = createServiceReadTransport(
      {
        ado: async () => {
          revoked = true;
          return 'fixture';
        },
        logs: async () => '',
      },
      fetcher,
    );
    await expect(
      transport.request('ado', 'https://dev.azure.com/org/project', undefined, () => {
        if (revoked) throw new Error('revoked');
      }),
    ).rejects.toThrow('revoked');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('caps responses and does not echo provider error bodies', async () => {
    const transport = createServiceReadTransport(
      { ado: async () => 'fixture', logs: async () => '' },
      vi.fn<typeof fetch>(async () => new Response('secret upstream diagnostics', { status: 403 })),
    );
    await expect(
      transport.request('ado', 'https://dev.azure.com/org/project', undefined, () => {}),
    ).rejects.toThrow('Service read failed (403)');
    const large = createServiceReadTransport(
      { ado: async () => 'fixture', logs: async () => '' },
      vi.fn<typeof fetch>(async () => new Response('x'.repeat(2_000_001))),
    );
    await expect(
      large.request('ado', 'https://dev.azure.com/org/project', undefined, () => {}),
    ).rejects.toThrow('size limit');
  });
});

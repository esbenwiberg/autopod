import { type ResolvedGitHubRule, githubAccessRuleSchema } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonGitHubAuth } from './daemon-github-auth.js';
import { GitHubDiscovery } from './discovery.js';
import { createGitHubDownloadClient } from './download-client.js';
import { createGitHubReadBroker } from './read-broker.js';

function fixture() {
  const rule: ResolvedGitHubRule = {
    repositoryIds: ['1'],
    workflowBindings: [],
    rule: githubAccessRuleSchema.parse({
      id: 'read',
      repositories: { mode: 'selected', repositoryIds: ['1'] },
      operations: ['issues.read', 'actions.read'],
    }),
  };
  const client = {
    get: vi.fn(
      async (path: string): Promise<unknown> =>
        path === '/repositories/1'
          ? { id: 1, name: 'repo', default_branch: 'main', owner: { id: 2, login: 'org' } }
          : [],
    ),
    download: vi.fn(async () => ({ bytes: Buffer.from('fixture logs'), mediaType: 'text/plain' })),
  };
  const context = vi.fn(async () => ({
    policy: { snapshot: [rule], currentCeiling: [rule] },
    snapshotDigest: 'digest',
    managed: false,
  }));
  const audit = vi.fn();
  return {
    client,
    context,
    rule,
    audit,
    broker: createGitHubReadBroker({
      client,
      discovery: new GitHubDiscovery(client),
      context,
      audit,
    }),
  };
}
describe('scoped GitHub reads', () => {
  it('can read Actions runs, jobs and logs only within an admitted repository', async () => {
    const f = fixture();
    await expect(
      f.broker.read('pod', { repositoryId: '1', resource: 'actions.jobLogs', jobId: 99 }),
    ).resolves.toMatchObject({ data: { text: 'fixture logs' } });
    expect(f.client.download).toHaveBeenCalledWith('/repos/org/repo/actions/jobs/99/logs');
    expect(f.audit).toHaveBeenCalledOnce();
    f.rule.rule.operations = ['issues.read'];
    await expect(
      f.broker.read('pod', { repositoryId: '1', resource: 'actions.jobs', runId: 5 }),
    ).rejects.toThrow('allowed access');
  });
  it('does not grant PR reads through issue list/get/comments', async () => {
    const f = fixture();
    const original = f.client.get.getMockImplementation();
    f.client.get.mockImplementation(async (path) =>
      path.endsWith('/issues/12')
        ? { number: 12, pull_request: { url: 'provider-pr' } }
        : path.includes('/issues?')
          ? [{ number: 11 }, { number: 12, pull_request: {} }]
          : original?.(path),
    );
    const result = await f.broker.read('pod', { repositoryId: '1', resource: 'issues.list' });
    expect(result).toMatchObject({ data: [{ number: 11 }] });
    await expect(
      f.broker.read('pod', { repositoryId: '1', resource: 'issues.get', number: 12 }),
    ).rejects.toThrow('separate');
    await expect(
      f.broker.read('pod', { repositoryId: '1', resource: 'issues.comments', number: 12 }),
    ).rejects.toThrow('separate');
  });
  it('withholds retrieved data if access was revoked during the read', async () => {
    const f = fixture();
    f.context
      .mockResolvedValueOnce({
        policy: { snapshot: [f.rule], currentCeiling: [f.rule] },
        snapshotDigest: 'digest',
        managed: false,
      })
      .mockResolvedValueOnce({
        policy: { snapshot: [f.rule], currentCeiling: [] },
        snapshotDigest: 'digest',
        managed: false,
      });
    await expect(
      f.broker.read('pod', { repositoryId: '1', resource: 'actions.runs' }),
    ).rejects.toThrow('allowed access');
    expect(f.audit).not.toHaveBeenCalled();
  });
});
const auth: DaemonGitHubAuth = {
  resolveCredential: async () => ({ token: 'fixture-auth', username: 'x-access-token' }),
  getStatus: async () => ({ available: true, login: 'operator', setup: '' }),
};
describe('GitHub log/artifact downloads', () => {
  it('uses authentication for the API only and does not extract downloaded archives', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://result.blob.core.windows.net/fixture?sig=fixture' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('zip fixture', { headers: { 'content-type': 'application/zip' } }),
      );
    const result = await createGitHubDownloadClient(auth, fetcher).download(
      '/repos/org/repo/actions/artifacts/1/zip',
    );
    expect(result.bytes.toString()).toBe('zip fixture');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toHaveProperty(
      'Authorization',
      'Bearer fixture-auth',
    );
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({});
  });
  it('rejects arbitrary redirect hosts and oversized data without leaking signed URLs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/private?secret=fixture' },
      }),
    );
    await expect(
      createGitHubDownloadClient(auth, fetcher).download('/repos/org/repo/actions/jobs/1/logs'),
    ).rejects.toThrow('download is unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(10 * 1024 * 1024 + 1)));
    await expect(
      createGitHubDownloadClient(auth, fetcher).download('/repos/org/repo/actions/jobs/1/logs'),
    ).rejects.toThrow('10 MiB');
  });
});

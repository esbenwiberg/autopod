import { githubAccessRuleSchema, repositoryConfigSchema } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { GitHubDiscovery } from './discovery.js';

const repo = (id: number, owner = 10) => ({
  id,
  name: `repo-${id}`,
  default_branch: 'main',
  owner: { id: owner, login: 'context-and' },
});
describe('GitHub discovery', () => {
  it('includes private accessible repositories, reads every page and filters exact owner identity', async () => {
    const first = Array.from({ length: 100 }, (_, i) => repo(i + 1));
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/users/')) return { id: 10 };
        return path.endsWith('page=1') ? first : [repo(101), repo(102, 20)];
      }),
    };
    const rule = githubAccessRuleSchema.parse({
      id: 'org',
      repositories: {
        mode: 'owner',
        ownerId: '10',
        ownerLogin: 'context-and',
        selection: { mode: 'all' },
      },
      operations: ['code.read'],
    });
    const result = await new GitHubDiscovery(client).resolveRepositories(rule, null);
    expect(result).toHaveLength(101);
    expect(result).toContain('101');
    expect(result).not.toContain('102');
    expect(
      client.get.mock.calls.some(([path]) => path.includes('/user/repos?visibility=all')),
    ).toBe(true);
    client.get.mockImplementation(async (path) => {
      if (path.startsWith('/users/')) return { id: 10 };
      if (path.endsWith('page=1')) return first;
      throw new Error('Second page unavailable');
    });
    await expect(new GitHubDiscovery(client).resolveRepositories(rule, null)).rejects.toThrow(
      'Second page',
    );
  });
  it('fails instead of granting a truncated set or following a changed owner identity', async () => {
    const client = { get: vi.fn(async () => Array.from({ length: 100 }, (_, i) => repo(i + 1))) };
    await expect(new GitHubDiscovery(client, 1).accessibleRepositories()).rejects.toThrow(
      'page limit',
    );
    const selected = githubAccessRuleSchema.parse({
      id: 'owner',
      repositories: {
        mode: 'owner',
        ownerId: '10',
        ownerLogin: 'context-and',
        selection: { mode: 'selected', repositoryIds: ['1'] },
      },
      operations: ['code.read'],
    });
    await expect(
      new GitHubDiscovery({ get: async () => repo(1, 20) }).resolveRepositories(selected, null),
    ).rejects.toThrow('no longer belongs');
  });
  it('pins workflow identities without changing the selected preset rule', async () => {
    const rule = githubAccessRuleSchema.parse({
      id: 'workflow',
      repositories: { mode: 'selected', repositoryIds: ['1'] },
      operations: ['workflows.dispatch'],
      workflows: {
        mode: 'selected',
        files: [{ repositoryId: '1', path: '.github/workflows/ci.yml' }],
      },
      branches: { mode: 'selected', names: ['main'] },
    });
    const client = {
      get: vi.fn(async (path: string) =>
        path.startsWith('/repositories/') ? repo(1) : { id: 42, path: '.github/workflows/ci.yml' },
      ),
    };
    const discovery = new GitHubDiscovery(client);
    const resolved = await discovery.resolveWorkflows({
      rule,
      repositoryIds: ['1'],
      workflowBindings: [],
    });
    expect(resolved.rule).toEqual(rule);
    expect(resolved.workflowBindings).toEqual([
      { repositoryId: '1', path: '.github/workflows/ci.yml', workflowId: '42' },
    ]);
    await expect(
      discovery.resolveWorkflows({ rule, repositoryIds: [], workflowBindings: [] }),
    ).rejects.toThrow('outside');
    client.get.mockImplementation(async (path) =>
      path.startsWith('/repositories/') ? repo(1) : { id: 42, path: '.github/workflows/other.yml' },
    );
    await expect(
      discovery.resolveWorkflows({ rule, repositoryIds: ['1'], workflowBindings: [] }),
    ).rejects.toThrow('identity changed');
  });
  it('uses the current repository binding and rejects credentials, other hosts and repository redirects', async () => {
    const client = { get: vi.fn(async () => repo(1)) };
    const discovery = new GitHubDiscovery(client);
    const rule = githubAccessRuleSchema.parse({
      id: 'read',
      repositories: { mode: 'current' },
      operations: ['code.read'],
    });
    const current = repositoryConfigSchema.parse({
      provider: 'github',
      remote: 'https://github.com/context-and/repo.git',
      setups: [{ id: 'default', name: 'Default' }],
      defaultSetupId: 'default',
    });
    expect(await discovery.resolveRepositories(rule, current)).toEqual(['1']);
    expect(client.get).toHaveBeenCalledWith('/repos/context-and/repo');
    await expect(discovery.repositoryById('2')).rejects.toThrow('identity changed');
    await expect(
      discovery.repositoryByRemote('https://example.com/context-and/repo'),
    ).rejects.toThrow('canonical');
    await expect(
      discovery.repositoryByRemote('https://user:pass@github.com/context-and/repo'),
    ).rejects.toThrow('canonical');
    await expect(discovery.resolveRepositories(rule, null)).rejects.toThrow('no current');
  });
});

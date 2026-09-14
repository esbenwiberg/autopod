import { type GitHubOperationPolicy, githubAccessRuleSchema } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { GitHubDiscovery } from './discovery.js';
import { type GitHubMutationClient, createGitHubMutationBroker } from './mutation-broker.js';
import { createGitHubOperationLedger } from './operation-ledger.js';

function fixture() {
  const db = createTestDb();
  insertConfigurationTestPod(db, 'pod');
  const repository = {
    id: 1,
    name: 'repo',
    default_branch: 'main',
    owner: { id: 10, login: 'context-and' },
  };
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith('/repositories/')) return repository;
    if (path.includes('/issues/'))
      return {
        number: 1,
        pull_request: { url: 'https://api.github.com/repos/context-and/repo/pulls/1' },
      };
    if (path.includes('/actions/runs/'))
      return {
        id: 100,
        repository,
        head_repository: repository,
        workflow_id: 20,
        head_branch: 'main',
      };
    if (path.includes('/git/ref/'))
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } };
    return { id: 20, path: '.github/workflows/ci.yml' };
  });
  const mutate = vi.fn<GitHubMutationClient['mutate']>().mockResolvedValue({
    status: 200,
    data: {
      workflow_run_id: 123,
      html_url: 'https://github.com/context-and/repo/actions/runs/123',
    },
  });
  const client = { get, mutate };
  const rule = githubAccessRuleSchema.parse({
    id: 'allowed',
    repositories: { mode: 'selected', repositoryIds: ['1'] },
    operations: ['issues.edit', 'prs.comment', 'workflows.dispatch', 'runs.rerun'],
    workflows: { mode: 'all' },
    branches: { mode: 'selected', names: ['main'] },
  });
  const bound = { rule, repositoryIds: ['1'], workflowBindings: [] };
  const policy: GitHubOperationPolicy = { snapshot: [bound], currentCeiling: [bound] };
  const context = vi.fn(async () => ({ snapshotDigest: 'snapshot', policy, managed: false }));
  const ledger = createGitHubOperationLedger(db);
  return {
    db,
    get,
    mutate,
    policy,
    context,
    ledger,
    broker: createGitHubMutationBroker({
      client,
      discovery: new GitHubDiscovery(client),
      ledger,
      context,
    }),
  };
}
describe('GitHub mutation broker', () => {
  it('rejects PR modification through issue endpoints but permits separately granted PR comments', async () => {
    const f = fixture();
    try {
      await expect(
        f.broker.execute('pod', {
          repositoryId: '1',
          operationKey: 'edit',
          operation: 'issues.edit',
          issueNumber: 1,
          title: 'Changed',
        }),
      ).rejects.toThrow('allowed access');
      expect(f.mutate).not.toHaveBeenCalled();
      expect(
        (
          await f.broker.execute('pod', {
            repositoryId: '1',
            operationKey: 'comment',
            operation: 'prs.comment',
            issueNumber: 1,
            body: 'A comment',
          })
        ).state,
      ).toBe('succeeded');
      expect(f.mutate).toHaveBeenCalledWith('POST', '/repos/context-and/repo/issues/1/comments', {
        body: 'A comment',
      });
      await expect(
        f.broker.execute('pod', {
          repositoryId: '1',
          operationKey: 'push',
          operation: 'prs.create',
        }),
      ).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
  it('records native dispatch receipts and never blindly repeats uncertain dispatch', async () => {
    const f = fixture();
    try {
      const request = {
        repositoryId: '1',
        operationKey: 'dispatch',
        operation: 'workflows.dispatch',
        workflowId: '20',
        branch: 'main',
      };
      const result = await f.broker.execute('pod', request);
      expect(result.receipt?.providerId).toBe('123');
      await f.broker.execute('pod', request);
      expect(f.mutate).toHaveBeenCalledTimes(1);
      f.mutate.mockRejectedValue(new Error('response dropped'));
      expect((await f.broker.execute('pod', { ...request, operationKey: 'lost' })).state).toBe(
        'uncertain',
      );
      expect((await f.broker.execute('pod', { ...request, operationKey: 'lost' })).state).toBe(
        'uncertain',
      );
      expect(f.mutate).toHaveBeenCalledTimes(2);
    } finally {
      f.db.close();
    }
  });
  it('rechecks delayed revocation and rejects run metadata supplied by the caller', async () => {
    const f = fixture();
    try {
      f.context.mockResolvedValueOnce({
        snapshotDigest: 'snapshot',
        policy: f.policy,
        managed: false,
      });
      f.context.mockResolvedValue({
        snapshotDigest: 'snapshot',
        policy: { ...f.policy, currentCeiling: [] },
        managed: false,
      });
      await expect(
        f.broker.execute('pod', {
          repositoryId: '1',
          operationKey: 'rerun',
          operation: 'runs.rerun',
          runId: 100,
        }),
      ).rejects.toThrow('allowed access');
      expect(f.mutate).not.toHaveBeenCalled();
      await expect(
        f.broker.execute('pod', {
          repositoryId: '1',
          operationKey: 'spoof',
          operation: 'runs.rerun',
          runId: 100,
          branch: 'main',
        }),
      ).rejects.toThrow();
      f.context.mockResolvedValue({ snapshotDigest: 'snapshot', policy: f.policy, managed: true });
      await expect(
        f.broker.execute('pod', {
          repositoryId: '1',
          operationKey: 'managed',
          operation: 'runs.rerun',
          runId: 100,
        }),
      ).rejects.toThrow('Managed grants');
      expect(f.mutate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
});

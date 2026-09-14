import {
  type GitHubOperationResource,
  type ResolvedGitHubRule,
  githubAccessRuleSchema,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { authorizeGitHubOperation } from './access-policy.js';

const rule = (id: string, repo: string, branch: string, workflow: string): ResolvedGitHubRule => ({
  rule: githubAccessRuleSchema.parse({
    id,
    repositories: { mode: 'selected', repositoryIds: [repo] },
    operations: ['workflows.dispatch', 'runs.rerun', 'runs.cancel'],
    workflows: {
      mode: 'selected',
      files: [
        { repositoryId: repo, path: `.github/workflows/${workflow}.yml`, workflowId: workflow },
      ],
    },
    branches: { mode: 'selected', names: [branch] },
  }),
  repositoryIds: [repo],
  workflowBindings: [
    { repositoryId: repo, path: `.github/workflows/${workflow}.yml`, workflowId: workflow },
  ],
});
const resource = (repo: string, branch: string, workflow: string): GitHubOperationResource => ({
  repository: {
    id: repo,
    ownerId: 'org',
    ownerLogin: 'context-and',
    name: 'repo',
    defaultBranch: 'main',
  },
  workflow: { repositoryId: repo, id: workflow, path: `.github/workflows/${workflow}.yml`, branch },
});
describe('GitHub access rules', () => {
  it('does not combine repository, branch and workflow grants across rules', () => {
    const rules = [rule('a', 'one', 'main', 'ci'), rule('b', 'two', 'dev', 'test')];
    const policy = { snapshot: rules, currentCeiling: rules };
    expect(
      authorizeGitHubOperation(policy, 'workflows.dispatch', resource('one', 'main', 'ci'))
        .snapshotRuleId,
    ).toBe('a');
    for (const request of [
      resource('two', 'main', 'ci'),
      resource('one', 'dev', 'ci'),
      resource('one', 'main', 'test'),
    ])
      expect(() => authorizeGitHubOperation(policy, 'workflows.dispatch', request)).toThrow(
        'allowed access',
      );
  });
  it('keeps all workflows independent of branches and rejects untrusted run metadata', () => {
    const bound = rule('all', 'one', 'main', 'ci');
    bound.rule.workflows = { mode: 'all' };
    const policy = { snapshot: [bound], currentCeiling: [bound] };
    expect(
      authorizeGitHubOperation(policy, 'runs.rerun', resource('one', 'main', 'new-workflow')),
    ).toBeDefined();
    expect(() =>
      authorizeGitHubOperation(policy, 'runs.rerun', resource('one', 'dev', 'ci')),
    ).toThrow();
    const unknown = resource('one', 'main', 'ci');
    if (unknown.workflow) unknown.workflow.branch = null;
    expect(() => authorizeGitHubOperation(policy, 'runs.cancel', unknown)).toThrow();
    if (unknown.workflow) {
      unknown.workflow.branch = 'main';
      unknown.workflow.repositoryId = 'other';
    }
    expect(() => authorizeGitHubOperation(policy, 'runs.cancel', unknown)).toThrow();
  });
  it('rejects transferred owner repositories, newly discovered repositories and current revocation', () => {
    const bound = rule('owner', 'one', 'main', 'ci');
    bound.rule.repositories = {
      mode: 'owner',
      ownerId: 'org',
      ownerLogin: 'context-and',
      selection: { mode: 'all' },
    };
    const policy = { snapshot: [bound], currentCeiling: [bound] };
    const moved = resource('one', 'main', 'ci');
    moved.repository.ownerId = 'different-org';
    expect(() => authorizeGitHubOperation(policy, 'workflows.dispatch', moved)).toThrow();
    expect(() =>
      authorizeGitHubOperation(policy, 'workflows.dispatch', resource('new-repo', 'main', 'ci')),
    ).toThrow();
    expect(() =>
      authorizeGitHubOperation(
        { ...policy, currentCeiling: [] },
        'workflows.dispatch',
        resource('one', 'main', 'ci'),
      ),
    ).toThrow();
    expect(() =>
      authorizeGitHubOperation(
        { ...policy, snapshot: [] },
        'workflows.dispatch',
        resource('one', 'main', 'ci'),
      ),
    ).toThrow();
  });
  it('separates issue mutation from PR comments and never grants source publication', () => {
    const bound = rule('issues', 'one', 'main', 'ci');
    bound.rule.operations = ['issues.edit', 'issues.close', 'issues.labels', 'issues.comment'];
    const target = { ...resource('one', 'main', 'ci'), issue: { number: 1, isPullRequest: true } };
    const policy = { snapshot: [bound], currentCeiling: [bound] };
    for (const operation of bound.rule.operations)
      expect(() => authorizeGitHubOperation(policy, operation, target)).toThrow();
    expect(() => authorizeGitHubOperation(policy, 'prs.comment', target)).toThrow();
    bound.rule.operations.push('prs.comment');
    expect(authorizeGitHubOperation(policy, 'prs.comment', target)).toBeDefined();
    target.issue.isPullRequest = false;
    expect(() => authorizeGitHubOperation(policy, 'prs.comment', target)).toThrow();
    expect(
      githubAccessRuleSchema.safeParse({ ...bound.rule, operations: ['prs.create'] }).success,
    ).toBe(false);
  });
});

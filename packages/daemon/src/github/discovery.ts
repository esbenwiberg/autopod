import type {
  GitHubAccessPreset,
  GitHubRepositoryIdentity,
  RepositoryConfig,
  ResolvedGitHubRule,
} from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';

export interface GitHubReadClient {
  get(path: string): Promise<unknown>;
}
const providerId = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform(String);
const repositorySchema = z.object({
  id: providerId,
  name: z.string().min(1),
  default_branch: z.string().min(1),
  owner: z.object({ id: providerId, login: z.string().min(1) }),
});
const workflowSchema = z.object({
  id: providerId,
  path: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
});
function repository(raw: unknown): GitHubRepositoryIdentity {
  const r = repositorySchema.parse(raw);
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner.id,
    ownerLogin: r.owner.login,
    defaultBranch: r.default_branch,
  };
}

/** Discovery reads complete result sets or fails; a partial page never becomes an access grant. */
export class GitHubDiscovery {
  constructor(
    private readonly client: GitHubReadClient,
    private readonly maxPages = 100,
  ) {}

  async repositoryById(id: string): Promise<GitHubRepositoryIdentity> {
    const key = providerId.parse(id);
    const found = repository(await this.client.get(`/repositories/${key}`));
    if (found.id !== key)
      configurationError('GitHub repository identity changed', 'GITHUB_IDENTITY_MISMATCH');
    return found;
  }

  async repositoryByRemote(remote: string): Promise<GitHubRepositoryIdentity> {
    const parsed = new URL(remote);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'github.com' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      configurationError('Expected a canonical GitHub HTTPS repository URL');
    const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)\/?$/.exec(parsed.pathname);
    if (!match?.[1] || !match[2]) configurationError('Expected a GitHub owner and repository');
    const name = match[2].replace(/\.git$/, '');
    return repository(
      await this.client.get(`/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(name)}`),
    );
  }

  async accessibleRepositories(): Promise<GitHubRepositoryIdentity[]> {
    const result: GitHubRepositoryIdentity[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      // /user/repos includes private repositories visible to the daemon's account.
      const values = z
        .array(repositorySchema)
        .parse(
          await this.client.get(
            `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
          ),
        );
      result.push(...values.map(repository));
      if (values.length < 100) return [...new Map(result.map((r) => [r.id, r])).values()];
    }
    configurationError(
      'GitHub repository discovery exceeded its page limit; narrow the selection',
      'GITHUB_DISCOVERY_INCOMPLETE',
    );
  }

  async workflowsForRepository(
    id: string,
  ): Promise<Array<{ repositoryId: string; id: string; path: string; name: string }>> {
    const repo = await this.repositoryById(id);
    const result = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const response = z
        .object({ workflows: z.array(workflowSchema.extend({ name: z.string() })) })
        .parse(
          await this.client.get(
            `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/actions/workflows?per_page=100&page=${page}`,
          ),
        );
      result.push(...response.workflows.map((item) => ({ repositoryId: repo.id, ...item })));
      if (response.workflows.length < 100) return result;
    }
    configurationError('GitHub workflow discovery is incomplete', 'GITHUB_DISCOVERY_INCOMPLETE');
  }

  async branchesForRepository(id: string): Promise<string[]> {
    const repo = await this.repositoryById(id);
    const names: string[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const response = z
        .array(z.object({ name: z.string().min(1) }))
        .parse(
          await this.client.get(
            `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/branches?per_page=100&page=${page}`,
          ),
        );
      names.push(...response.map((item) => item.name));
      if (response.length < 100) return [...new Set(names)];
    }
    configurationError('GitHub branch discovery is incomplete', 'GITHUB_DISCOVERY_INCOMPLETE');
  }

  async resolveRepositories(
    rule: GitHubAccessPreset['rules'][number],
    current: RepositoryConfig | null,
  ): Promise<string[]> {
    const scope = rule.repositories;
    if (scope.mode === 'current') {
      if (!current || current.provider !== 'github')
        configurationError(
          'This launch has no current GitHub repository',
          'GITHUB_REPOSITORY_REQUIRED',
        );
      const found = current.providerRepositoryId
        ? await this.repositoryById(current.providerRepositoryId)
        : await this.repositoryByRemote(current.remote);
      return [found.id];
    }
    if (scope.mode === 'owner' && scope.selection.mode === 'all') {
      const owner = z
        .object({ id: providerId })
        .parse(await this.client.get(`/users/${encodeURIComponent(scope.ownerLogin)}`));
      if (owner.id !== scope.ownerId)
        configurationError('Selected GitHub owner identity changed', 'GITHUB_IDENTITY_MISMATCH');
      return (await this.accessibleRepositories())
        .filter((r) => r.ownerId === scope.ownerId)
        .map((r) => r.id)
        .sort();
    }
    const ids =
      scope.mode === 'selected'
        ? scope.repositoryIds
        : scope.selection.mode === 'selected'
          ? scope.selection.repositoryIds
          : [];
    const result: string[] = [];
    for (const id of ids) {
      const found = await this.repositoryById(id);
      if (scope.mode === 'owner' && found.ownerId !== scope.ownerId)
        configurationError(
          'A selected repository no longer belongs to the selected owner',
          'GITHUB_IDENTITY_MISMATCH',
        );
      result.push(found.id);
    }
    return result;
  }

  async resolveWorkflows(bound: ResolvedGitHubRule): Promise<ResolvedGitHubRule> {
    if (bound.rule.workflows.mode === 'all') return bound;
    const files = [];
    for (const selected of bound.rule.workflows.files) {
      if (!bound.repositoryIds.includes(selected.repositoryId))
        configurationError(
          'Workflow selection is outside the rule repositories',
          'GITHUB_WORKFLOW_MISMATCH',
        );
      const repo = await this.repositoryById(selected.repositoryId);
      const found = workflowSchema.parse(
        await this.client.get(
          `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/actions/workflows/${encodeURIComponent(selected.workflowId ?? selected.path.slice('.github/workflows/'.length))}`,
        ),
      );
      if (found.path !== selected.path || (selected.workflowId && found.id !== selected.workflowId))
        configurationError('Selected workflow identity changed', 'GITHUB_WORKFLOW_MISMATCH');
      files.push({ ...selected, workflowId: found.id });
    }
    return { ...bound, workflowBindings: files };
  }
}

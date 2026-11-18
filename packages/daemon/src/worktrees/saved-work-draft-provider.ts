import type {
  SavedDraftObservation,
  SavedDraftProvider,
  SavedDraftTarget,
} from '../interfaces/pr-manager.js';
import { draftError } from '../pods/saved-work-draft-repository.js';
import { parseGitHubRepoUrl } from './github-url-identity.js';
import { assertMergeRepository } from './merge-source-identity.js';

export const draftMarker = (id: string) => `<!-- autopod-saved-work-draft:${id} -->`;
export function verifyDraftObservation(target: SavedDraftTarget, observed: SavedDraftObservation) {
  assertMergeRepository(
    { repository: target.repository, branch: target.branch, baseBranch: target.baseBranch },
    observed.repository,
  );
  const url = new URL(observed.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !observed.draft ||
    !observed.open ||
    observed.merged ||
    observed.head !== target.head ||
    observed.branch !== target.branch ||
    observed.baseBranch !== target.baseBranch ||
    !observed.body.includes(draftMarker(target.operationId))
  )
    draftError(
      'Provider result is not the operation-owned open draft at the exact selected source and base.',
    );
  const repo = new URL(target.repository.replace(/\.git$/, ''));
  if (url.host !== repo.host || !url.pathname.startsWith(`${repo.pathname}/`))
    draftError('Provider URL does not belong to the selected repository.');
  return {
    url: observed.url,
    draft: true as const,
    head: target.head,
    branch: target.branch,
    baseBranch: target.baseBranch,
  };
}
type JsonRequest = (
  url: string,
  init?: RequestInit,
  beforeWrite?: () => Promise<void>,
) => Promise<unknown>;
interface GitHubRow {
  html_url: string;
  state: string;
  merged_at?: string | null;
  draft: boolean;
  body: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}
export function githubSavedDraft(request: JsonRequest): SavedDraftProvider {
  return {
    async find(target) {
      const { owner, repo } = parseGitHubRepoUrl(target.repository);
      const query = new URLSearchParams({
        state: 'all',
        head: `${owner}:${target.branch}`,
        // Observe all dispositions/targets for this operation branch. Filtering
        // by the expected base could hide an occupied or retargeted PR.
        per_page: '2',
      });
      const rows = (await request(
        `https://api.github.com/repos/${owner}/${repo}/pulls?${query}`,
      )) as GitHubRow[];
      if (!Array.isArray(rows) || rows.length > 1) draftError('Ambiguous draft provider result.');
      const r = rows[0];
      if (!r) return null;
      if (
        r.head?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
        r.base?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
      )
        draftError('Draft repository identity mismatch.');
      return {
        url: r.html_url,
        repository: `https://github.com/${r.base.repo.full_name}`,
        branch: r.head.ref,
        baseBranch: r.base.ref,
        head: r.head.sha,
        draft: r.draft === true,
        open: r.state === 'open',
        merged: !!r.merged_at,
        body: r.body ?? '',
      };
    },
    async create(target, body, onPrepared) {
      const { owner, repo } = parseGitHubRepoUrl(target.repository);
      await request(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: `Saved work for review (${target.operationId})`,
            head: target.branch,
            base: target.baseBranch,
            body,
            draft: true,
          }),
        },
        onPrepared,
      );
    },
  };
}

export function ghSavedDraft(
  exec: (
    args: string[],
    cwd: string,
    onPrepared?: () => Promise<void>,
  ) => Promise<{ stdout: string }>,
): SavedDraftProvider {
  const api = githubSavedDraft(async (url) => {
    const result = await exec(['api', url], '');
    return JSON.parse(result.stdout);
  });
  return {
    find: api.find,
    async create(t, body, onPrepared) {
      await exec(
        [
          'pr',
          'create',
          '--repo',
          t.repository,
          '--head',
          t.branch,
          '--base',
          t.baseBranch,
          '--title',
          `Saved work for review (${t.operationId})`,
          '--body',
          body,
          '--draft',
        ],
        t.worktreePath,
        onPrepared,
      );
    },
  };
}

export function adoSavedDraft(repository: string, request: JsonRequest): SavedDraftProvider {
  interface Row {
    pullRequestId: number;
    sourceRefName: string;
    targetRefName: string;
    status: string;
    isDraft: boolean;
    description: string;
    lastMergeSourceCommit: { commitId: string };
    repository: { webUrl: string };
  }
  return {
    async find(t) {
      const query = new URLSearchParams({
        'api-version': '7.1',
        'searchCriteria.status': 'all',
        'searchCriteria.sourceRefName': `refs/heads/${t.branch}`,
        $top: '2',
      });
      const result = (await request(`/pullrequests?${query}`)) as { value: Row[] };
      if (!Array.isArray(result.value) || result.value.length > 1)
        draftError('Ambiguous ADO draft result.');
      const r = result.value[0];
      if (!r) return null;
      if (!Number.isSafeInteger(r.pullRequestId) || r.pullRequestId <= 0 || !r.repository?.webUrl)
        draftError('ADO draft identity unavailable.');
      return {
        url: `${repository}/pullrequest/${r.pullRequestId}`,
        repository: r.repository.webUrl,
        branch: r.sourceRefName.replace(/^refs\/heads\//, ''),
        baseBranch: r.targetRefName.replace(/^refs\/heads\//, ''),
        head: r.lastMergeSourceCommit?.commitId,
        draft: r.isDraft === true,
        open: r.status === 'active',
        merged: r.status === 'completed',
        body: r.description ?? '',
      };
    },
    async create(t, body, onPrepared) {
      assertMergeRepository(
        { repository: t.repository, branch: t.branch, baseBranch: t.baseBranch },
        repository,
      );
      await request(
        '/pullrequests?api-version=7.1',
        {
          method: 'POST',
          body: JSON.stringify({
            sourceRefName: `refs/heads/${t.branch}`,
            targetRefName: `refs/heads/${t.baseBranch}`,
            title: `Saved work for review (${t.operationId})`,
            description: body,
            isDraft: true,
          }),
        },
        onPrepared,
      );
    },
  };
}

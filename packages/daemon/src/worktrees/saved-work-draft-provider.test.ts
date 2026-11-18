import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedDraftObservation, SavedDraftTarget } from '../interfaces/pr-manager.js';
import { logger } from '../test-utils/mock-helpers.js';
import { AdoPrManager } from './ado-pr-manager.js';
import { GhPrManager, GitHubApiPrManager } from './pr-manager.js';
import { draftMarker, verifyDraftObservation } from './saved-work-draft-provider.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const t: SavedDraftTarget = {
  repository: 'https://github.com/org/repo',
  branch: 'autopod/saved-work/test/operation',
  baseBranch: 'main',
  head: 'a'.repeat(40),
  operationId: 'operation',
  worktreePath: '/independent',
};
const body = `${draftMarker(t.operationId)}\nValidation NOT RUN. Original retained.`;
const githubRow = () => ({
  html_url: 'https://github.com/org/repo/pull/9',
  state: 'open',
  merged_at: null,
  draft: true,
  body,
  head: { ref: t.branch, sha: t.head, repo: { full_name: 'org/repo' } },
  base: { ref: 'main', repo: { full_name: 'org/repo' } },
});
function apiMock() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init?.method === 'POST' ? githubRow() : [githubRow()]), {
        status: 200,
      });
    }),
  );
  return calls;
}
describe('real saved-work draft provider contract', () => {
  it('GitHub API sends draft:true and reobserves exact provider identity without AI', async () => {
    const calls = apiMock();
    const manager = new GitHubApiPrManager({ pat: 'fixture-token', logger });
    const admission = vi.fn(async () => {});
    await manager.savedDraft.create(t, body, admission);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      draft: true,
      body,
      head: t.branch,
      base: 'main',
    });
    expect(admission).toHaveBeenCalledTimes(1);
    const observed = await manager.savedDraft.find(t);
    const query = new URL(calls[1]!.url).searchParams;
    expect(query.get('head')).toBe(`org:${t.branch}`);
    expect(query.get('state')).toBe('all');
    expect(query.has('base')).toBe(false); // Retargeted PRs must remain visible and blocked.
    expect(verifyDraftObservation(t, observed!)).toMatchObject({ draft: true, head: t.head });
  });
  it('gh CLI sends --draft with daemon credentials and exact target', async () => {
    const run = vi.mocked(execFile);
    run.mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, 'https://github.com/org/repo/pull/9\n', '');
      return {};
    }) as typeof execFile);
    const manager = new GhPrManager({
      logger,
      githubAuth: {
        resolveCredential: vi.fn(async () => ({ token: 'daemon-only', source: 'fixture' })),
      } as never,
    });
    await manager.savedDraft.create(t, body, async () => {});
    expect(run).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--draft', '--head', t.branch, '--base', 'main']),
      expect.objectContaining({
        cwd: t.worktreePath,
        env: expect.objectContaining({ GH_TOKEN: 'daemon-only' }),
      }),
      expect.any(Function),
    );
  });
  it('ADO sends isDraft:true after authentication and reobserves exact source', async () => {
    const repo = 'https://dev.azure.com/org/project/_git/repo';
    const target = { ...t, repository: repo };
    const calls: RequestInit[] = [];
    const urls: string[] = [];
    const row = {
      pullRequestId: 9,
      sourceRefName: `refs/heads/${t.branch}`,
      targetRefName: 'refs/heads/main',
      status: 'active',
      isDraft: true,
      description: body,
      repository: { webUrl: repo },
      lastMergeSourceCommit: { commitId: t.head },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(init);
        urls.push(url);
        return new Response(JSON.stringify(init.method === 'POST' ? row : { value: [row] }));
      }),
    );
    const manager = new AdoPrManager({
      orgUrl: 'https://dev.azure.com/org',
      project: 'project',
      repoName: 'repo',
      getToken: async () => 'daemon-ado',
      logger,
    });
    await manager.savedDraft.create(target, body, async () => {});
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ isDraft: true, description: body });
    expect(verifyDraftObservation(target, (await manager.savedDraft.find(target))!)).toMatchObject({
      draft: true,
      head: t.head,
    });
    const query = new URL(urls[1]!).searchParams;
    expect(query.get('searchCriteria.sourceRefName')).toBe(`refs/heads/${t.branch}`);
    expect(query.get('searchCriteria.status')).toBe('all');
    expect(query.has('searchCriteria.targetRefName')).toBe(false);
  });
  it.each([
    { draft: false },
    { open: false },
    { merged: true },
    { head: 'b'.repeat(40) },
    { branch: 'other' },
    { baseBranch: 'other' },
    { repository: 'https://github.com/other/repo' },
    { body: 'matching SHA alone is not ownership' },
    { url: 'https://evil.example/pull/9' },
    { url: 'https://github.com/org/repo/issues/9' },
    { url: 'https://github.com/org/repo/pull/9?redirect=other' },
  ])('refuses provider result mismatch %j', (override) => {
    const observed: SavedDraftObservation = {
      url: 'https://github.com/org/repo/pull/9',
      repository: t.repository,
      branch: t.branch,
      baseBranch: t.baseBranch,
      head: t.head,
      draft: true,
      open: true,
      merged: false,
      body,
      ...override,
    };
    expect(() => verifyDraftObservation(t, observed)).toThrow();
  });
  it.each([
    'https://github.com/ORG/Repo',
    'https://github.com/org/repo/',
    'https://github.com/ORG/Repo.git/',
  ])('reconciles the canonical PR URL for repository variant %s', (repository) => {
    expect(
      verifyDraftObservation(
        { ...t, repository },
        {
          url: 'https://github.com/org/repo/pull/9',
          repository: 'https://github.com/org/repo',
          branch: t.branch,
          baseBranch: t.baseBranch,
          head: t.head,
          draft: true,
          open: true,
          merged: false,
          body,
        },
      ).url,
    ).toBe('https://github.com/org/repo/pull/9');
  });
  it.each([
    'https://dev.azure.com/org/project/_git/repo/',
    'https://org.visualstudio.com/project/_git/repo',
  ])('reconciles canonical ADO PR URLs for %s', (repository) => {
    expect(
      verifyDraftObservation(
        { ...t, repository },
        {
          url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/9',
          repository: 'https://dev.azure.com/org/project/_git/repo',
          branch: t.branch,
          baseBranch: t.baseBranch,
          head: t.head,
          draft: true,
          open: true,
          merged: false,
          body,
        },
      ).draft,
    ).toBe(true);
  });
  it('never writes when final source admission fails', async () => {
    const calls = apiMock();
    const manager = new GitHubApiPrManager({ pat: 'fixture', logger });
    await expect(
      manager.savedDraft.create(t, body, async () => {
        throw new Error('stale custody');
      }),
    ).rejects.toThrow('stale custody');
    expect(calls).toEqual([]);
  });
});

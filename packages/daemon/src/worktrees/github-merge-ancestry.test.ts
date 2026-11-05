import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeAncestryRequest, PrMergeStatus } from '../interfaces/pr-manager.js';
import { verifyGitHubMergedSourceAncestry } from './github-merge-ancestry.js';
import { GitHubApiPrManager } from './pr-manager.js';

const config: MergeAncestryRequest = {
  prUrl: 'https://github.com/org/repo/pull/113',
  publishedHeadSha: 'a'.repeat(40),
  mergedHeadSha: 'b'.repeat(40),
  expectedTarget: {
    repository: 'https://github.com/org/repo',
    branch: 'review',
    baseBranch: 'main',
  },
};
const status: PrMergeStatus = {
  merged: true,
  open: false,
  headSha: config.mergedHeadSha,
  sourceTarget: config.expectedTarget,
  blockReason: null,
  ciFailures: [],
  reviewComments: [],
};
const comparison = {
  status: 'ahead',
  behind_by: 0,
  base_commit: { sha: config.publishedHeadSha },
  merge_base_commit: { sha: config.publishedHeadSha },
};
afterEach(() => vi.restoreAllMocks());
describe('GitHub already-merged source ancestry', () => {
  it('binds both fresh PR observations and exact-SHA compare', async () => {
    const observe = vi.fn(async () => status);
    const compare = vi.fn(async () => comparison);
    expect(await verifyGitHubMergedSourceAncestry(config, observe, compare)).toMatchObject({
      publishedHeadSha: config.publishedHeadSha,
      mergedHeadSha: config.mergedHeadSha,
      target: config.expectedTarget,
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(compare).toHaveBeenCalledWith(config.publishedHeadSha, config.mergedHeadSha);
  });
  it.each([
    'diverged',
    'behind',
    'unknown',
    'base',
    'merge-base',
    'behind-count',
  ])('refuses %s comparison', async (kind) => {
    const bad = { ...comparison };
    if (kind === 'base') bad.base_commit = { sha: 'c'.repeat(40) };
    else if (kind === 'merge-base') bad.merge_base_commit = { sha: 'c'.repeat(40) };
    else if (kind === 'behind-count') bad.behind_by = 1;
    else bad.status = kind;
    expect(
      await verifyGitHubMergedSourceAncestry(
        config,
        async () => status,
        async () => bad,
      ),
    ).toBeNull();
  });
  it.each([false, true])('refuses unmerged disposition (open: %s)', async (open) => {
    const compare = vi.fn();
    expect(
      await verifyGitHubMergedSourceAncestry(
        config,
        async () => ({ ...status, merged: false, open }),
        compare,
      ),
    ).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });
  it('refuses a changed source during comparison', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, headSha: 'c'.repeat(40) });
    await expect(
      verifyGitHubMergedSourceAncestry(config, observe, async () => comparison),
    ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
  });
  it.each([
    true,
    false,
  ])('bounds real PR observations and avoids open-PR CI scans (merged: %s)', async (merged) => {
    const pr = {
      number: 113,
      state: merged ? 'closed' : 'open',
      merged,
      head: {
        sha: config.mergedHeadSha,
        ref: config.expectedTarget.branch,
        repo: { full_name: 'org/repo' },
      },
      base: { ref: 'main', repo: { full_name: 'org/repo' } },
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith('/pulls/113')) return new Response(JSON.stringify(pr));
      if (address.includes('/compare/')) return new Response(JSON.stringify(comparison));
      throw new Error('Unexpected CI scan or provider mutation');
    });
    const manager = new GitHubApiPrManager({
      pat: 'fixture-only',
      logger: pino({ level: 'silent' }),
    });
    const proof = await manager.verifyMergedSourceAncestry(config);
    expect(Boolean(proof)).toBe(merged);
    expect(fetch).toHaveBeenCalledTimes(merged ? 3 : 1);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('uses authenticated bounded GitHub API read-only requests', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(comparison)));
    const manager = new GitHubApiPrManager({
      pat: 'fixture-only',
      logger: pino({ level: 'silent' }),
    });
    vi.spyOn(manager, 'getPrStatus').mockResolvedValue(status);
    expect(await manager.verifyMergedSourceAncestry(config)).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/org/repo/compare/${config.publishedHeadSha}...${config.mergedHeadSha}?per_page=1`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-only' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { GitHubApiPrManager } from './pr-manager.js';

const url = 'https://github.com/org/repo/pull/42';
const sha = 'a'.repeat(40);
const target = { repository: 'https://github.com/org/repo', branch: 'feature', baseBranch: 'main' };
const pr = {
  number: 42,
  state: 'open',
  merged: false,
  draft: true,
  head: { sha, ref: 'feature', repo: { full_name: 'org/repo' } },
  base: { ref: 'main', repo: { full_name: 'org/repo' } },
};

describe('GitHub draft admission', () => {
  it('exposes a draft in status even with passing checks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = String(input);
      if (request.endsWith('/pulls/42')) return Response.json(pr);
      if (request.endsWith('/check-runs')) return Response.json({ check_runs: [] });
      if (request.endsWith('/reviews')) return Response.json([]);
      throw new Error(`Unexpected request: ${request}`);
    });
    try {
      const manager = new GitHubApiPrManager({ logger: pino({ level: 'silent' }), pat: 'test' });
      expect(await manager.getPrStatus({ prUrl: url })).toMatchObject({
        mergeBlocked: true,
        blockReason: expect.stringMatching(/draft/i),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('blocks a draft observed immediately before mutation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(pr));
    const onPrepared = vi.fn();
    try {
      const manager = new GitHubApiPrManager({ logger: pino({ level: 'silent' }), pat: 'test' });
      await expect(
        manager.mergePr({ prUrl: url, expectedHeadSha: sha, expectedTarget: target, onPrepared }),
      ).rejects.toThrow(/draft/i);
      expect(onPrepared).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

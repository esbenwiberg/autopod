import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubIssueClient } from './github-issue-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GitHubIssueClient', () => {
  let client: GitHubIssueClient;

  beforeEach(() => {
    client = new GitHubIssueClient({
      owner: 'org',
      repo: 'app',
      pat: 'ghp_test123',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listByLabel', () => {
    it('fetches issues and filters by label prefix', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            number: 1,
            title: 'Fix bug',
            body: '- [ ] Fix login\n- [ ] Fix logout',
            html_url: 'https://github.com/org/app/issues/1',
            labels: [{ name: 'autopod' }, { name: 'bug' }],
          },
          {
            number: 2,
            title: 'Feature',
            body: 'Add feature',
            html_url: 'https://github.com/org/app/issues/2',
            labels: [{ name: 'enhancement' }], // No autopod label
          },
          {
            number: 3,
            title: 'PR',
            body: 'Pull request',
            html_url: 'https://github.com/org/app/pull/3',
            labels: [{ name: 'autopod' }],
            pull_request: {}, // Should be excluded
          },
        ],
      });

      const candidates = await client.listByLabel('autopod');

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe('1');
      expect(candidates[0].title).toBe('Fix bug');
      expect(candidates[0].triggerLabel).toBe('autopod');
      expect(candidates[0].acceptanceCriteria).toEqual(['Fix login', 'Fix logout']);
    });

    it('matches prefixed labels like autopod:backend', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            number: 5,
            title: 'Backend fix',
            body: 'Fix the API',
            html_url: 'https://github.com/org/app/issues/5',
            labels: [{ name: 'autopod:backend' }],
          },
        ],
      });

      const candidates = await client.listByLabel('autopod');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].triggerLabel).toBe('autopod:backend');
    });

    it('sends correct auth headers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await client.listByLabel('autopod');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/org/app/issues'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_test123',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(client.listByLabel('autopod')).rejects.toThrow(
        'GitHub API error: 403 Forbidden',
      );
    });

    it('truncates long issue bodies', async () => {
      const longBody = 'x'.repeat(20_000);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            number: 1,
            title: 'Long issue',
            body: longBody,
            html_url: 'https://github.com/org/app/issues/1',
            labels: [{ name: 'autopod' }],
          },
        ],
      });

      const candidates = await client.listByLabel('autopod');
      expect(candidates[0].body.length).toBe(10_000);
    });
  });

  describe('addLabel', () => {
    it('sends POST with label array', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await client.addLabel('42', 'autopod:in-progress');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/app/issues/42/labels',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ labels: ['autopod:in-progress'] }),
        }),
      );
    });
  });

  describe('removeLabel', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await client.removeLabel('42', 'autopod');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/app/issues/42/labels/autopod',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('ignores 404 (label not present)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await expect(client.removeLabel('42', 'missing')).resolves.toBeUndefined();
    });
  });

  describe('addComment', () => {
    it('posts comment body', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await client.addComment('42', 'Pod started.');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/app/issues/42/comments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'Pod started.' }),
        }),
      );
    });
  });
});

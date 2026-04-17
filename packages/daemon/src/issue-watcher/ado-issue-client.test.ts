import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdoIssueClient } from './ado-issue-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('AdoIssueClient', () => {
  let client: AdoIssueClient;

  beforeEach(() => {
    client = new AdoIssueClient({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'MyProject',
      pat: 'ado-test-pat',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listByLabel', () => {
    it('queries WIQL and batch-fetches details, filtering by tag prefix', async () => {
      // WIQL response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workItems: [{ id: 100 }, { id: 200 }],
        }),
      });

      // Batch details response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 100,
              fields: {
                'System.Title': 'Fix dark mode',
                'System.Description': '<p>Dark mode is broken</p>',
                'System.Tags': 'autopod; enhancement',
                'Microsoft.VSTS.Common.AcceptanceCriteria':
                  '<ul><li>Dark mode toggle works</li><li>Theme persists</li></ul>',
              },
              _links: {
                html: {
                  href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/100',
                },
              },
            },
            {
              id: 200,
              fields: {
                'System.Title': 'Unrelated item',
                'System.Description': '<p>No matching tag</p>',
                'System.Tags': 'enhancement',
                'Microsoft.VSTS.Common.AcceptanceCriteria': null,
              },
              _links: {
                html: {
                  href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/200',
                },
              },
            },
          ],
        }),
      });

      const candidates = await client.listByLabel('autopod');

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe('100');
      expect(candidates[0].title).toBe('Fix dark mode');
      expect(candidates[0].body).toBe('Dark mode is broken');
      expect(candidates[0].triggerLabel).toBe('autopod');
      expect(candidates[0].acceptanceCriteria).toEqual([
        'Dark mode toggle works',
        'Theme persists',
      ]);
    });

    it('sends Basic auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [] }),
      });

      await client.listByLabel('autopod');

      const expectedAuth = `Basic ${Buffer.from(':ado-test-pat').toString('base64')}`;
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedAuth,
          }),
        }),
      );
    });

    it('returns empty array when no work items match WIQL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [] }),
      });

      const candidates = await client.listByLabel('autopod');
      expect(candidates).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No batch fetch
    });

    it('matches prefixed tags like autopod:backend', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [{ id: 300 }] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 300,
              fields: {
                'System.Title': 'Backend task',
                'System.Description': null,
                'System.Tags': 'autopod:backend; urgent',
                'Microsoft.VSTS.Common.AcceptanceCriteria': null,
              },
              _links: {
                html: {
                  href: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/300',
                },
              },
            },
          ],
        }),
      });

      const candidates = await client.listByLabel('autopod');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].triggerLabel).toBe('autopod:backend');
    });
  });

  describe('addLabel', () => {
    it('reads current tags and appends new one', async () => {
      // getTags call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fields: { 'System.Tags': 'existing-tag' },
        }),
      });
      // patchTags call
      mockFetch.mockResolvedValueOnce({ ok: true });

      await client.addLabel('100', 'autopod:in-progress');

      // Second call should be PATCH with combined tags
      const patchCall = mockFetch.mock.calls[1];
      expect(patchCall[1].method).toBe('PATCH');
      const patchBody = JSON.parse(patchCall[1].body as string);
      expect(patchBody[0].value).toBe('existing-tag; autopod:in-progress');
    });

    it('skips if tag already present', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fields: { 'System.Tags': 'autopod:in-progress; other' },
        }),
      });

      await client.addLabel('100', 'autopod:in-progress');
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only the read, no patch
    });
  });

  describe('removeLabel', () => {
    it('reads current tags and removes specified one', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fields: { 'System.Tags': 'autopod; autopod:in-progress' },
        }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      await client.removeLabel('100', 'autopod');

      const patchCall = mockFetch.mock.calls[1];
      const patchBody = JSON.parse(patchCall[1].body as string);
      expect(patchBody[0].value).toBe('autopod:in-progress');
    });

    it('skips if tag not present', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fields: { 'System.Tags': 'other-tag' },
        }),
      });

      await client.removeLabel('100', 'autopod');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('addComment', () => {
    it('posts comment via work item comments API', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await client.addComment('100', 'Pod started.');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/_apis/wit/workitems/100/comments'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Pod started.' }),
        }),
      );
    });
  });
});

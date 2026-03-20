import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubHandler } from './github-handler.js';

function mockResponse(
  data: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '0',
      ...opts.headers,
    },
  });
}

const logger = pino({ level: 'silent' });

function makeAction(name: string, fields: string[] = []): any {
  return {
    name,
    description: '',
    group: {} as any,
    handler: {} as any,
    params: {},
    response: { fields },
  };
}

describe('createGitHubHandler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws during execute when no token is available', async () => {
    const handler = createGitHubHandler({ logger, getSecret: () => undefined });

    await expect(
      handler.execute(makeAction('read_issue'), {
        repo: 'octocat/hello-world',
        issue_number: 1,
      }),
    ).rejects.toThrow(/token/i);
  });

  it('returns a handler with handlerType "github"', () => {
    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });
    expect(handler.handlerType).toBe('github');
  });

  it('accepts token from github-pat fallback', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse({ number: 1, title: 'Test' }));

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'github-pat' ? 'ghp_fallback' : undefined),
    });

    // Should not throw — uses github-pat fallback
    await handler.execute(makeAction('read_issue', ['number', 'title']), {
      repo: 'octocat/hello-world',
      issue_number: 1,
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('throws on invalid repo format', async () => {
    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    await expect(
      handler.execute(makeAction('read_issue'), { repo: 'bad-repo', issue_number: 1 }),
    ).rejects.toThrow(/invalid repo/i);
  });

  it('read_issue calls correct GitHub API URL and picks fields', async () => {
    const issueData = {
      number: 42,
      title: 'Bug report',
      state: 'open',
      body: 'Something broke',
      user: { login: 'octocat' },
    };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(issueData));

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    const result = await handler.execute(makeAction('read_issue', ['number', 'title', 'state']), {
      repo: 'octocat/hello-world',
      issue_number: 42,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/octocat/hello-world/issues/42',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_test',
        }),
      }),
    );
    expect(result).toEqual({ number: 42, title: 'Bug report', state: 'open' });
  });

  it('search_issues URL-encodes query and adds state filter', async () => {
    const searchData = { items: [{ number: 1, title: 'Match' }] };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(searchData));

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    await handler.execute(makeAction('search_issues'), {
      repo: 'octocat/hello-world',
      query: 'bug fix',
      state: 'closed',
    });

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    // Query should be URL-encoded and include repo + state
    expect(calledUrl).toContain('/search/issues?q=');
    expect(calledUrl).toContain(
      encodeURIComponent('bug fix repo:octocat/hello-world is:issue state:closed'),
    );
  });

  it('read_file decodes base64 content', async () => {
    const rawContent = 'console.log("hello")';
    const content = Buffer.from(rawContent).toString('base64');
    const fileData = { name: 'index.js', path: 'src/index.js', content, encoding: 'base64' };
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(fileData));

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    const result: any = await handler.execute(makeAction('read_file', ['content', 'path']), {
      repo: 'octocat/hello-world',
      path: 'src/index.js',
    });

    expect(result.content).toBe(rawContent);
  });

  it('read_pr_diff filters by file_path param', async () => {
    // read_pr_diff fetches /pulls/{n}/files which returns JSON array of file objects
    const filesData = [
      { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
      { filename: 'src/bar.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(mockResponse(filesData));

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    const result: any = await handler.execute(makeAction('read_pr_diff', ['filename', 'patch']), {
      repo: 'octocat/hello-world',
      pr_number: 1,
      file_path: 'src/foo.ts',
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/foo.ts');
  });

  it('throws on HTTP error with status and body', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse({ message: 'Not Found' }, { status: 404 }),
    );

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    await expect(
      handler.execute(makeAction('read_issue'), {
        repo: 'octocat/hello-world',
        issue_number: 999,
      }),
    ).rejects.toThrow(/404/);
  });

  it('throws on unknown action', async () => {
    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    await expect(
      handler.execute(makeAction('nonexistent_action'), { repo: 'octocat/hello-world' }),
    ).rejects.toThrow(/unknown/i);
  });

  it('tracks rate limits from response headers', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(
        { number: 1, title: 'Test' },
        { headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': '0' } },
      ),
    );

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    // Should succeed — remaining is above threshold and reset is in the past
    const result = await handler.execute(makeAction('read_issue', ['number']), {
      repo: 'octocat/hello-world',
      issue_number: 1,
    });
    expect(result).toEqual({ number: 1 });
  });

  // IMPORTANT: This test must run last because it poisons module-level rate limit state.
  // The github-handler uses `let rateLimitRemaining` at module scope which persists across tests.
  it('throws when rate limit is exceeded', async () => {
    // First call: set rate limit very low with a reset far in the future
    const futureReset = String(Math.floor(Date.now() / 1000) + 3600);
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockResponse(
        { number: 1 },
        { headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': futureReset } },
      ),
    );

    const handler = createGitHubHandler({
      logger,
      getSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_test' : undefined),
    });

    // First call sets the rate limit state
    await handler.execute(makeAction('read_issue'), {
      repo: 'octocat/hello-world',
      issue_number: 1,
    });

    // Second call should throw because remaining <= 10 and reset is in the future
    await expect(
      handler.execute(makeAction('read_issue'), {
        repo: 'octocat/hello-world',
        issue_number: 2,
      }),
    ).rejects.toThrow(/rate limit/i);
  });
});

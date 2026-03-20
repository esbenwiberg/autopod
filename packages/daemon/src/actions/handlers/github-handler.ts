import type { ActionDefinition } from '@autopod/shared';
import type { ActionHandler, HandlerConfig } from './handler.js';
import { fetchWithTimeout, pickFields, pickFieldsArray } from './handler.js';

const GITHUB_API = 'https://api.github.com';

/** Simple in-memory rate limit tracker */
let rateLimitRemaining = 5000;
let rateLimitReset = 0;

export function createGitHubHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret } = config;
  const log = logger.child({ handler: 'github' });

  function getToken(): string {
    const token = getSecret('GITHUB_TOKEN') ?? getSecret('github-pat');
    if (!token) throw new Error('GitHub token not configured (GITHUB_TOKEN or github-pat)');
    return token;
  }

  async function githubFetch(path: string, accept?: string): Promise<unknown> {
    // Respect rate limits
    if (rateLimitRemaining <= 10 && Date.now() / 1000 < rateLimitReset) {
      const waitSec = Math.ceil(rateLimitReset - Date.now() / 1000);
      throw new Error(`GitHub rate limit exceeded — resets in ${waitSec}s`);
    }

    const token = getToken();
    const response = await fetchWithTimeout(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    });

    // Track rate limits
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining) rateLimitRemaining = Number.parseInt(remaining, 10);
    if (reset) rateLimitReset = Number.parseInt(reset, 10);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 200)}`);
    }

    // Some endpoints return raw text (diffs)
    if (accept === 'application/vnd.github.diff') {
      return { diff: await response.text() };
    }

    return response.json();
  }

  async function paginate(path: string, maxResults: number): Promise<unknown[]> {
    const perPage = Math.min(maxResults, 100);
    const data = (await githubFetch(
      `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}`,
    )) as unknown[];
    return Array.isArray(data) ? data.slice(0, maxResults) : [data];
  }

  return {
    handlerType: 'github',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      const repo = params.repo as string;
      const [owner, name] = repo.split('/');
      if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);

      log.debug({ action: action.name, repo }, 'Executing GitHub action');

      switch (action.name) {
        case 'read_issue': {
          const data = await githubFetch(`/repos/${owner}/${name}/issues/${params.issue_number}`);
          return pickFields(data, action.response.fields);
        }

        case 'search_issues': {
          const state = (params.state as string) ?? 'open';
          const max = (params.max_results as number) ?? 10;
          const query = encodeURIComponent(`${params.query} repo:${repo} is:issue state:${state}`);
          const data = (await githubFetch(`/search/issues?q=${query}&per_page=${max}`)) as {
            items: unknown[];
          };
          return pickFieldsArray(data.items ?? [], action.response.fields);
        }

        case 'read_issue_comments': {
          const max = (params.max_results as number) ?? 20;
          const items = await paginate(
            `/repos/${owner}/${name}/issues/${params.issue_number}/comments`,
            max,
          );
          return pickFieldsArray(items, action.response.fields);
        }

        case 'read_pr': {
          const data = await githubFetch(`/repos/${owner}/${name}/pulls/${params.pr_number}`);
          return pickFields(data, action.response.fields);
        }

        case 'read_pr_comments': {
          const max = (params.max_results as number) ?? 20;
          const items = await paginate(
            `/repos/${owner}/${name}/pulls/${params.pr_number}/comments`,
            max,
          );
          return pickFieldsArray(items, action.response.fields);
        }

        case 'read_pr_diff': {
          const data = (await githubFetch(
            `/repos/${owner}/${name}/pulls/${params.pr_number}/files`,
          )) as Array<Record<string, unknown>>;

          let files = data;
          if (params.file_path) {
            files = files.filter((f) => f.filename === params.file_path);
          }
          return pickFieldsArray(files, action.response.fields);
        }

        case 'read_file': {
          const ref = params.ref ? `?ref=${encodeURIComponent(params.ref as string)}` : '';
          const data = (await githubFetch(
            `/repos/${owner}/${name}/contents/${encodeURIComponent(params.path as string)}${ref}`,
          )) as Record<string, unknown>;

          // Content is base64-encoded
          if (data.content && typeof data.content === 'string' && data.encoding === 'base64') {
            data.content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
          }
          return pickFields(data, action.response.fields);
        }

        case 'search_code': {
          const max = (params.max_results as number) ?? 10;
          const query = encodeURIComponent(`${params.query} repo:${repo}`);
          const data = (await githubFetch(
            `/search/code?q=${query}&per_page=${max}`,
            'application/vnd.github.text-match+json',
          )) as { items: unknown[] };
          return pickFieldsArray(data.items ?? [], action.response.fields);
        }

        default:
          throw new Error(`Unknown GitHub action: ${action.name}`);
      }
    },
  };
}

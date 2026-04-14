import type { IssueClient, WatchedIssueCandidate } from './issue-client.js';
import { parseAcceptanceCriteria } from './issue-client.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

interface GitHubIssueClientConfig {
  owner: string;
  repo: string;
  pat: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

export class GitHubIssueClient implements IssueClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly pat: string;

  constructor(config: GitHubIssueClientConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.pat = config.pat;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
  }

  private url(path: string): string {
    return `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}${path}`;
  }

  async listByLabel(labelPrefix: string): Promise<WatchedIssueCandidate[]> {
    // Fetch open issues — filter client-side for label prefix match
    const response = await fetch(
      this.url('/issues?state=open&per_page=100&sort=created&direction=asc'),
      { headers: this.headers() },
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const issues = (await response.json()) as GitHubIssue[];
    const prefixPattern = new RegExp(`^${escapeRegex(labelPrefix)}(:.+)?$`);

    const candidates: WatchedIssueCandidate[] = [];
    for (const issue of issues) {
      // GitHub returns PRs in the issues endpoint — skip them
      if (issue.pull_request) continue;

      const matchingLabel = issue.labels.find((l) => prefixPattern.test(l.name));
      if (!matchingLabel) continue;

      const body = issue.body ?? '';
      candidates.push({
        id: String(issue.number),
        title: issue.title,
        body: body.length > 10_000 ? body.slice(0, 10_000) : body,
        url: issue.html_url,
        labels: issue.labels.map((l) => l.name),
        triggerLabel: matchingLabel.name,
        acceptanceCriteria: parseAcceptanceCriteria(body),
      });
    }

    return candidates;
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    const response = await fetch(this.url(`/issues/${issueId}/labels`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [label] }),
    });
    if (!response.ok) {
      throw new Error(`GitHub add label failed: ${response.status} ${response.statusText}`);
    }
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    const response = await fetch(
      this.url(`/issues/${issueId}/labels/${encodeURIComponent(label)}`),
      { method: 'DELETE', headers: this.headers() },
    );
    // 404 means label wasn't present — not an error
    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub remove label failed: ${response.status} ${response.statusText}`);
    }
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const response = await fetch(this.url(`/issues/${issueId}/comments`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      throw new Error(`GitHub add comment failed: ${response.status} ${response.statusText}`);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

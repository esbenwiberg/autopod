import type { Profile } from '@autopod/shared';
import { parseAdoRepoUrl } from '../worktrees/ado-pr-manager.js';
import { parseGitHubRepoUrl } from '../worktrees/pr-manager.js';
import { AdoIssueClient } from './ado-issue-client.js';
import { GitHubIssueClient } from './github-issue-client.js';

export interface WatchedIssueCandidate {
  id: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  triggerLabel: string;
  acceptanceCriteria?: string[];
}

export interface IssueClient {
  listByLabel(labelPrefix: string): Promise<WatchedIssueCandidate[]>;
  addLabel(issueId: string, label: string): Promise<void>;
  removeLabel(issueId: string, label: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}

export function createIssueClient(profile: Profile): IssueClient {
  if (!profile.repoUrl) {
    throw new Error(
      `Profile '${profile.name}' has no repoUrl — cannot create an issue client for artifact-mode profiles`,
    );
  }
  if (profile.prProvider === 'github') {
    const { owner, repo } = parseGitHubRepoUrl(profile.repoUrl);
    return new GitHubIssueClient({ owner, repo, pat: profile.githubPat ?? '' });
  }
  const { orgUrl, project } = parseAdoRepoUrl(profile.repoUrl);
  return new AdoIssueClient({ orgUrl, project, pat: profile.adoPat ?? '' });
}

/**
 * Parse GitHub-flavored markdown checkboxes as acceptance criteria.
 * Works for both checked `- [x]` and unchecked `- [ ]` items.
 */
export function parseAcceptanceCriteria(body: string): string[] | undefined {
  const checkboxPattern = /^[-*]\s+\[[ x]\]\s+(.+)$/gm;
  const criteria: string[] = [];
  for (const match of body.matchAll(checkboxPattern)) {
    criteria.push(match[1].trim());
  }
  return criteria.length > 0 ? criteria : undefined;
}

/**
 * Strip HTML tags from a string (for ADO descriptions / acceptance criteria fields).
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

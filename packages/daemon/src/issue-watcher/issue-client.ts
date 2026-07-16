import type { Profile } from '@autopod/shared';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
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
  requirements?: string[];
}

export interface IssueClient {
  listByLabel(labelPrefix: string): Promise<WatchedIssueCandidate[]>;
  addLabel(issueId: string, label: string): Promise<void>;
  removeLabel(issueId: string, label: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}

export async function createIssueClient(
  profile: Profile,
  githubAuth?: DaemonGitHubAuth,
): Promise<IssueClient> {
  if (!profile.repoUrl) {
    throw new Error(
      `Profile '${profile.name}' has no repoUrl — cannot create an issue client for artifact-mode profiles`,
    );
  }
  if (profile.prProvider === 'github') {
    const { owner, repo } = parseGitHubRepoUrl(profile.repoUrl);
    const credential = await githubAuth?.resolveCredential();
    if (!credential) throw new Error('Daemon GitHub authentication is not configured');
    return new GitHubIssueClient({ owner, repo, pat: credential.token });
  }
  const { orgUrl, project } = parseAdoRepoUrl(profile.repoUrl);
  return new AdoIssueClient({ orgUrl, project, pat: profile.adoPat ?? '' });
}

/** Strip HTML tags from a string (for ADO descriptions / requirements fields). */
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

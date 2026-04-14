import type { IssueClient, WatchedIssueCandidate } from './issue-client.js';
import { stripHtml } from './issue-client.js';

const ADO_API_VERSION = '7.1';

interface AdoIssueClientConfig {
  orgUrl: string;
  project: string;
  pat: string;
}

interface WiqlResponse {
  workItems: Array<{ id: number }>;
}

interface WorkItemFields {
  'System.Title': string;
  'System.Description': string | null;
  'System.Tags': string | null;
  'Microsoft.VSTS.Common.AcceptanceCriteria': string | null;
}

interface WorkItem {
  id: number;
  fields: WorkItemFields;
  _links: { html: { href: string } };
}

export class AdoIssueClient implements IssueClient {
  private readonly orgUrl: string;
  private readonly project: string;
  private readonly pat: string;

  constructor(config: AdoIssueClientConfig) {
    this.orgUrl = config.orgUrl;
    this.project = config.project;
    this.pat = config.pat;
  }

  private headers(contentType = 'application/json'): Record<string, string> {
    const auth = Buffer.from(`:${this.pat}`).toString('base64');
    return {
      Authorization: `Basic ${auth}`,
      'Content-Type': contentType,
    };
  }

  async listByLabel(labelPrefix: string): Promise<WatchedIssueCandidate[]> {
    // WIQL query: find open work items with tags containing the prefix
    const wiqlUrl = `${this.orgUrl}/${this.project}/_apis/wit/wiql?api-version=${ADO_API_VERSION}`;
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${escapeWiql(this.project)}' AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' AND [System.Tags] CONTAINS '${escapeWiql(labelPrefix)}' ORDER BY [System.ChangedDate] DESC`;

    const wiqlResponse = await fetch(wiqlUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query }),
    });

    if (!wiqlResponse.ok) {
      throw new Error(`ADO WIQL failed: ${wiqlResponse.status} ${wiqlResponse.statusText}`);
    }

    const wiqlResult = (await wiqlResponse.json()) as WiqlResponse;
    if (wiqlResult.workItems.length === 0) return [];

    // Batch fetch work item details (max 200 per call)
    const ids = wiqlResult.workItems
      .slice(0, 200)
      .map((wi) => wi.id)
      .join(',');
    const detailUrl = `${this.orgUrl}/${this.project}/_apis/wit/workitems?ids=${ids}&$expand=all&api-version=${ADO_API_VERSION}`;
    const detailResponse = await fetch(detailUrl, {
      headers: this.headers(),
    });

    if (!detailResponse.ok) {
      throw new Error(
        `ADO work item fetch failed: ${detailResponse.status} ${detailResponse.statusText}`,
      );
    }

    const detailResult = (await detailResponse.json()) as {
      value: WorkItem[];
    };
    const prefixPattern = new RegExp(`^${escapeRegex(labelPrefix)}(:.+)?$`);

    const candidates: WatchedIssueCandidate[] = [];
    for (const wi of detailResult.value) {
      const tags = parseTags(wi.fields['System.Tags']);
      const matchingTag = tags.find((t) => prefixPattern.test(t));
      if (!matchingTag) continue;

      const description = wi.fields['System.Description']
        ? stripHtml(wi.fields['System.Description'])
        : '';
      const body = description.length > 10_000 ? description.slice(0, 10_000) : description;

      // Parse acceptance criteria from the dedicated ADO field
      const acHtml = wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'];
      let acceptanceCriteria: string[] | undefined;
      if (acHtml) {
        const acText = stripHtml(acHtml);
        const lines = acText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (lines.length > 0) acceptanceCriteria = lines;
      }

      candidates.push({
        id: String(wi.id),
        title: wi.fields['System.Title'],
        body,
        url: wi._links.html.href,
        labels: tags,
        triggerLabel: matchingTag,
        acceptanceCriteria,
      });
    }

    return candidates;
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    // Read current tags, append the new one
    const current = await this.getTags(issueId);
    if (current.includes(label)) return;
    const newTags = [...current, label].join('; ');
    await this.patchTags(issueId, newTags);
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    const current = await this.getTags(issueId);
    const filtered = current.filter((t) => t !== label);
    if (filtered.length === current.length) return; // tag wasn't present
    await this.patchTags(issueId, filtered.join('; '));
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const url = `${this.orgUrl}/${this.project}/_apis/wit/workitems/${issueId}/comments?api-version=${ADO_API_VERSION}-preview.4`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text: body }),
    });
    if (!response.ok) {
      throw new Error(`ADO add comment failed: ${response.status} ${response.statusText}`);
    }
  }

  private async getTags(issueId: string): Promise<string[]> {
    const url = `${this.orgUrl}/${this.project}/_apis/wit/workitems/${issueId}?fields=System.Tags&api-version=${ADO_API_VERSION}`;
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`ADO get work item failed: ${response.status} ${response.statusText}`);
    }
    const wi = (await response.json()) as {
      fields: { 'System.Tags': string | null };
    };
    return parseTags(wi.fields['System.Tags']);
  }

  private async patchTags(issueId: string, tags: string): Promise<void> {
    const url = `${this.orgUrl}/${this.project}/_apis/wit/workitems/${issueId}?api-version=${ADO_API_VERSION}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: this.headers('application/json-patch+json'),
      body: JSON.stringify([
        {
          op: 'replace',
          path: '/fields/System.Tags',
          value: tags,
        },
      ]),
    });
    if (!response.ok) {
      throw new Error(`ADO patch tags failed: ${response.status} ${response.statusText}`);
    }
  }
}

/** Parse ADO semicolon-separated tags into an array, trimming whitespace. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''");
}

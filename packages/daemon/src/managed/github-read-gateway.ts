import type { ManagedPodRequest } from '@autopod/shared';
import { z } from 'zod';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import { canonical, digest } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';

const requestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('issue-view'),
      repository: z.string(),
      number: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('issue-comments'),
      repository: z.string(),
      number: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('issue-list'),
      repository: z.string(),
      search: z.string().max(512),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
]);

export interface ManagedGitHubReadConfig {
  alias: string;
  bindingDigest: string;
  repository: string;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('managed-github-read-unavailable');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error('managed-github-response-too-large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class ManagedGitHubReadGateway {
  constructor(
    readonly service: ManagedPodService,
    readonly config: ManagedGitHubReadConfig,
    readonly auth: DaemonGitHubAuth,
    readonly transport: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository))
      throw new Error('managed-github-repository-invalid');
  }
  preflight(request: ManagedPodRequest): void {
    const bindings = request.effectiveGrant.scope.identityBindings.filter(
      (item) =>
        item.alias === this.config.alias && item.bindingDigest === this.config.bindingDigest,
    );
    if (
      bindings.length !== 1 ||
      !request.effectiveGrant.scope.allowedEffects.includes('github.issue.read')
    )
      throw new Error('managed-github-read-not-granted');
  }
  async invoke(
    installation: string,
    podId: string,
    revision: number,
    key: string,
    raw: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key) || Buffer.byteLength(raw) > 4096)
      throw new Error('managed-github-request-invalid');
    const request = requestSchema.parse(JSON.parse(raw));
    if (request.repository !== this.config.repository)
      throw new Error('managed-github-repository-unbound');
    const active = () => {
      const row = this.service.row(installation, podId);
      this.service.requireActive(row);
      if (row.grant_revision !== revision) throw new Error('managed-github-stale-revision');
      this.preflight(JSON.parse(row.request_json) as ManagedPodRequest);
      return row;
    };
    active();
    const requestDigest = digest(request);
    const prior = this.service.db
      .transaction(() => {
        active();
        const found = this.service.db
          .prepare(
            'SELECT request_digest,grant_revision,response_json FROM managed_github_reads WHERE pod_id=? AND operation_key=?',
          )
          .get(podId, key) as
          | { request_digest: string; grant_revision: number; response_json: string | null }
          | undefined;
        if (found && (found.request_digest !== requestDigest || found.grant_revision !== revision))
          throw new Error('managed-github-replay-conflict');
        if (!found)
          this.service.db
            .prepare(
              'INSERT INTO managed_github_reads(pod_id,operation_key,request_digest,grant_revision) VALUES (?,?,?,?)',
            )
            .run(podId, key, requestDigest, revision);
        return found?.response_json ?? null;
      })
      .immediate();
    if (prior !== null) return prior;
    const credential = await this.auth.resolveCredential();
    active();
    const route =
      request.operation === 'issue-view'
        ? `/repos/${this.config.repository}/issues/${request.number}`
        : request.operation === 'issue-comments'
          ? `/repos/${this.config.repository}/issues/${request.number}/comments?per_page=100`
          : `/search/issues?q=${encodeURIComponent(`${request.search} repo:${this.config.repository} is:issue`)}&per_page=${request.limit}`;
    const response = await this.transport(`https://api.github.com${route}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024)
      throw new Error('managed-github-read-unavailable');
    const value = await readBoundedJson(response, 1024 * 1024);
    const encoded = canonical(value);
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new Error('managed-github-response-too-large');
    this.service.db
      .transaction(() => {
        active();
        this.service.db
          .prepare(
            'UPDATE managed_github_reads SET response_json=? WHERE pod_id=? AND operation_key=? AND response_json IS NULL',
          )
          .run(encoded, podId, key);
      })
      .immediate();
    const stored = this.service.db
      .prepare('SELECT response_json FROM managed_github_reads WHERE pod_id=? AND operation_key=?')
      .get(podId, key) as { response_json: string };
    return stored.response_json;
  }
}

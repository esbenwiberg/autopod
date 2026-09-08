import type { FinalizeSourceDeliveryRequest } from '@autopod/shared';
import { sha256 } from './canonical.js';
import type { DraftBroker, DraftRecord } from './source-git.js';

/** Daemon-only GitHub transport; short-lived installation tokens never enter a pod or ledger. */
export class GitHubDraftBroker implements DraftBroker {
  constructor(
    readonly repositories: ReadonlyMap<string, string>,
    readonly token: (repository: string) => Promise<string>,
    readonly body: (digest: string) => Promise<string>,
    readonly request: typeof fetch = fetch,
  ) {}
  private repo(request: FinalizeSourceDeliveryRequest): string {
    const repository = this.repositories.get(request.repository);
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error('source-github-repository-unbound');
    return repository;
  }
  private async call(
    spec: FinalizeSourceDeliveryRequest,
    method: string,
    route: string,
    body?: object,
    etag?: string,
  ): Promise<{ data: unknown; etag: string | null }> {
    const response = await this.request(`https://api.github.com/repos/${this.repo(spec)}${route}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${await this.token(spec.repository)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(etag ? { 'If-Match': etag } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('source-github-request-uncertain');
    return { data: await response.json(), etag: response.headers.get('etag') };
  }
  private record(spec: FinalizeSourceDeliveryRequest, raw: unknown): DraftRecord {
    const value = raw as {
      number?: number;
      draft?: boolean;
      state?: string;
      merged?: boolean;
      body?: string;
      head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
      base?: { ref?: string; repo?: { full_name?: string } };
    };
    const repo = this.repo(spec);
    if (
      !Number.isSafeInteger(value.number) ||
      !value.number ||
      value.state !== 'open' ||
      value.merged ||
      value.head?.repo?.full_name !== repo ||
      value.base?.repo?.full_name !== repo ||
      !value.head.sha ||
      !value.head.ref ||
      !value.base.ref
    )
      throw new Error('source-github-response-invalid');
    return {
      id: value.number,
      repository: spec.repository,
      head: value.head.ref,
      base: value.base.ref,
      commit: value.head.sha,
      draft: value.draft === true,
      bodyDigest: sha256(Buffer.from(value.body ?? '')),
    };
  }
  async inspect(spec: FinalizeSourceDeliveryRequest): Promise<DraftRecord | null> {
    const owner = this.repo(spec).split('/')[0]!;
    const { data } = await this.call(
      spec,
      'GET',
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${spec.head}`)}&base=${encodeURIComponent(spec.base)}&per_page=100`,
    );
    if (!Array.isArray(data) || data.length > 1) throw new Error('source-draft-ambiguous');
    // Closed/merged or a foreign-repository PR must never authorize a replacement PR.
    return data.length ? this.record(spec, data[0]) : null;
  }
  private async content(spec: FinalizeSourceDeliveryRequest): Promise<string> {
    const body = await this.body(spec.bodyDigest);
    if (sha256(Buffer.from(body)) !== spec.bodyDigest)
      throw new Error('source-body-digest-mismatch');
    return body;
  }
  async create(spec: FinalizeSourceDeliveryRequest): Promise<DraftRecord> {
    return this.record(
      spec,
      (
        await this.call(spec, 'POST', '/pulls', {
          title: `Dispatcher ${spec.dispatcherAttemptId}`,
          body: await this.content(spec),
          head: spec.head,
          base: spec.base,
          draft: true,
        })
      ).data,
    );
  }
  async update(spec: FinalizeSourceDeliveryRequest, existing: DraftRecord): Promise<DraftRecord> {
    const { data, etag } = await this.call(spec, 'GET', `/pulls/${existing.id}`);
    const current = this.record(spec, data);
    if (!etag || JSON.stringify(current) !== JSON.stringify(existing) || !current.draft)
      throw new Error('source-draft-changed');
    // No base/head/draft transition fields are sent. Live conditional-update behavior is a deployment gate.
    await this.call(
      spec,
      'PATCH',
      `/pulls/${existing.id}`,
      { body: await this.content(spec) },
      etag,
    );
    return this.record(spec, (await this.call(spec, 'GET', `/pulls/${existing.id}`)).data);
  }
}

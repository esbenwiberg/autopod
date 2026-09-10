import type { ManagedPodRequest } from '@autopod/shared';
import type { BoundedProviderTransport } from './bounded-provider.js';
import { ManagedProviderFailure } from './bounded-provider.js';
import { digest } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';
import { ManagedQuotaBroker } from './quota-broker.js';

/** Trusted host-side entrypoint, never an unscoped public provider proxy. */
export class ManagedProviderGateway {
  private closed = false;
  private readonly maximumPromptBytes: number;
  private readonly active = new Set<AbortController>();
  constructor(
    readonly service: ManagedPodService,
    readonly transport: BoundedProviderTransport,
    readonly maximumRequests = 1,
  ) {
    this.maximumPromptBytes = transport.maximumPromptBytes ?? 16384;
    if (
      !Number.isSafeInteger(this.maximumPromptBytes) ||
      this.maximumPromptBytes < 1 ||
      this.maximumPromptBytes > 128 * 1024
    )
      throw new Error('managed-provider-input-limit-invalid');
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 100)
      throw new Error('managed-provider-request-limit-invalid');
    if (
      !service.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_provider_requests'",
        )
        .get()
    )
      throw new Error('managed-provider-journal-migration-required');
    const columns = new Set(
      (
        service.db.prepare('PRAGMA table_info(managed_provider_requests)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (
      !['failure_phase', 'failure_reason', 'failure_http_status'].every((column) =>
        columns.has(column),
      )
    )
      throw new Error('managed-provider-diagnostic-migration-required');
  }
  preflight(request: ManagedPodRequest): void {
    if (this.closed) throw new Error('managed-provider-gateway-closed');
    const budget = request.effectiveGrant.budget;
    if (
      ('mode' in budget ? 'request-time' : 'hard-tokens') !==
      (this.transport.budgetMode ?? 'hard-tokens')
    )
      throw new Error('managed-provider-budget-mode-mismatch');
    if (
      'mode' in budget &&
      !this.service.db
        .prepare('PRAGMA table_info(managed_provider_requests)')
        .all()
        .some((column) => (column as { name: string }).name === 'actual_tokens')
    )
      throw new Error('managed-provider-usage-migration-required');
    this.transport.preflight(request.route);
  }
  async invoke(
    installation: string,
    podId: string,
    revision: number,
    key: string,
    prompt: string,
    maximumTokens: number,
  ): Promise<{ state: 'observed'; value: string } | { state: 'reserved' }> {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(key) ||
      !prompt ||
      Buffer.byteLength(prompt) > this.maximumPromptBytes ||
      !Number.isSafeInteger(maximumTokens) ||
      (maximumTokens !== 0 && maximumTokens < 2)
    )
      throw new Error('managed-provider-request-invalid');
    const assertActive = () => {
      const row = this.service.row(installation, podId);
      this.service.requireActive(row);
      if (row.grant_revision !== revision) throw new Error('managed-provider-stale-revision');
      return row;
    };
    const row = assertActive();
    const request = JSON.parse(row.request_json) as ManagedPodRequest;
    this.preflight(request);
    const budget = request.effectiveGrant.budget;
    const requestTime = 'mode' in budget;
    if (requestTime ? maximumTokens !== 0 : maximumTokens < 2)
      throw new Error('managed-provider-budget-mode-mismatch');
    const transportDigest = digest({
      transport: this.transport.bindingDigest,
      maximumRequests: this.maximumRequests,
      maximumPromptBytes: this.maximumPromptBytes,
    });
    const requestDigest = digest({ prompt, maximumTokens, route: request.route });
    const prior = this.service.db
      .transaction(() => {
        assertActive();
        const prior = this.service.db
          .prepare('SELECT * FROM managed_provider_requests WHERE pod_id=? AND operation_key=?')
          .get(podId, key) as
          | {
              request_digest: string;
              transport_digest: string;
              grant_revision: number;
              state: string;
              response_json: string | null;
            }
          | undefined;
        if (prior) {
          if (
            prior.request_digest !== requestDigest ||
            prior.transport_digest !== transportDigest ||
            prior.grant_revision !== revision
          )
            throw new Error('managed-provider-replay-conflict');
          return prior;
        }
        if (
          this.service.db
            .prepare(
              'SELECT 1 FROM managed_provider_requests WHERE pod_id=? AND transport_digest<>?',
            )
            .get(podId, transportDigest)
        )
          throw new Error('managed-provider-binding-changed');
        const count = this.service.db
          .prepare('SELECT count(*) AS n FROM managed_provider_requests WHERE pod_id=?')
          .get(podId) as { n: number };
        if (
          count.n >=
          Math.min(
            this.maximumRequests,
            'mode' in budget ? budget.maxProviderRequests : this.maximumRequests,
          )
        )
          throw new Error('managed-provider-request-limit');
        // The detached supervisor treats fully reserved quota as exhausted. Keep one
        // token unreserved so an in-flight request cannot stop its own worker.
        const current = assertActive();
        if ('maxTokens' in budget && current.consumed_tokens + maximumTokens >= budget.maxTokens)
          throw new Error('managed-provider-budget-headroom-required');
        this.service.db
          .prepare(
            "INSERT INTO managed_provider_requests (pod_id,operation_key,request_digest,transport_digest,grant_revision,state,response_json) VALUES (?,?,?,?,?,'reserved',NULL)",
          )
          .run(podId, key, requestDigest, transportDigest, revision);
        return undefined;
      })
      .immediate();
    if (prior) {
      if (prior.state !== 'observed') return { state: 'reserved' };
      const value: unknown = JSON.parse(prior.response_json ?? 'null');
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536)
        throw new Error('managed-provider-cache-invalid');
      return { state: 'observed', value };
    }
    const controller = new AbortController();
    this.active.add(controller);
    const watch = setInterval(() => {
      try {
        assertActive();
      } catch {
        controller.abort();
      }
    }, 50);
    watch.unref();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(
        1,
        Math.min(
          requestTime ? 180000 : 60000,
          (Math.min(budget.expiresAt, row.created_at + budget.maxDurationSeconds) -
            this.service.now()) *
            1000,
        ),
      ),
    );
    timeout.unref();
    try {
      const generate = (route: ManagedPodRequest['route'], limit: number) =>
        this.transport.generate(route, prompt, limit, controller.signal, () => {
          controller.signal.throwIfAborted();
          assertActive();
        });
      const result = requestTime
        ? await (async () => {
            const observed = await generate(request.route, 0);
            if (!Number.isSafeInteger(observed.consumedTokens) || observed.consumedTokens < 0)
              throw new Error('managed-provider-usage-invalid');
            // Measured usage can survive a late response; completion/delivery still needs active authority.
            this.service.db
              .transaction(() => {
                this.service.db
                  .prepare(
                    'UPDATE managed_provider_requests SET actual_tokens=? WHERE pod_id=? AND operation_key=? AND actual_tokens IS NULL',
                  )
                  .run(observed.consumedTokens, podId, key);
                this.service.db
                  .prepare(`UPDATE managed_pods SET consumed_tokens=(
                    SELECT coalesce(sum(actual_tokens),0) FROM managed_provider_requests
                    WHERE pod_id=? AND actual_tokens IS NOT NULL) WHERE pod_id=?`)
                  .run(podId, podId);
              })
              .immediate();
            return { state: 'observed' as const, value: observed.value };
          })()
        : await new ManagedQuotaBroker(this.service).invoke(
            installation,
            podId,
            key,
            maximumTokens,
            generate,
          );
      controller.signal.throwIfAborted();
      assertActive();
      if (result.state === 'observed') {
        if (
          typeof result.value !== 'string' ||
          !result.value ||
          Buffer.byteLength(result.value) > 65536
        )
          throw new Error('managed-provider-output-invalid');
        this.service.db
          .transaction(() => {
            assertActive();
            this.service.db
              .prepare(
                "UPDATE managed_provider_requests SET state='observed',response_json=? WHERE pod_id=? AND operation_key=?",
              )
              .run(JSON.stringify(result.value), podId, key);
          })
          .immediate();
      }
      return result;
    } catch (error) {
      if (error instanceof ManagedProviderFailure) {
        const { phase, reason, httpStatus } = error.diagnostic;
        this.service.db
          .prepare(
            `UPDATE managed_provider_requests
             SET failure_phase=?,failure_reason=?,failure_http_status=?
             WHERE pod_id=? AND operation_key=? AND state='reserved'`,
          )
          .run(phase, reason, httpStatus, podId, key);
      }
      throw new Error('managed-provider-attempt-unavailable');
    } finally {
      clearInterval(watch);
      clearTimeout(timeout);
      this.active.delete(controller);
    }
  }
  close(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}

import type { ManagedPodRequest, Route } from '@autopod/shared';
import { digest } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';

/** Provider calls reserve worst-case cost before invoking a pinned account transport.
 * An uncertain call stays reserved; replay cannot call the provider a second time.
 * Only the authenticated attempt gateway can invoke this broker, never a worker-selected route.
 */
export class ManagedQuotaBroker {
  constructor(private readonly service: ManagedPodService) {}
  async invoke<T>(
    installation: string,
    podId: string,
    operationKey: string,
    maximumTokens: number,
    provider: (
      route: Route,
      maximumTokens: number,
    ) => Promise<{ value: T; consumedTokens: number }>,
  ): Promise<{ state: 'observed'; value: T } | { state: 'reserved' }> {
    if (
      !Number.isSafeInteger(maximumTokens) ||
      maximumTokens <= 0 ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(operationKey)
    ) {
      throw new Error('invalid-provider-allowance');
    }
    const reserve = this.service.db.transaction(() => {
      const row = this.service.row(installation, podId);
      this.service.requireActive(row);
      const request = JSON.parse(row.request_json) as ManagedPodRequest;
      if (!('maxTokens' in request.effectiveGrant.budget)) throw new Error('token-budget-required');
      const prior = this.service.db
        .prepare('SELECT * FROM managed_provider_allowances WHERE pod_id=? AND operation_key=?')
        .get(podId, operationKey) as
        | { reserved_tokens: number; route_digest: string; grant_revision: number }
        | undefined;
      if (prior) {
        if (
          prior.reserved_tokens !== maximumTokens ||
          prior.route_digest !== digest(request.route) ||
          prior.grant_revision !== row.grant_revision
        )
          throw new Error('provider-allowance-conflict');
        return null;
      }
      if (row.consumed_tokens + maximumTokens > request.effectiveGrant.budget.maxTokens)
        throw new Error('provider-budget-exhausted');
      this.service.db
        .prepare("INSERT INTO managed_provider_allowances VALUES (?,?,?,?,?,NULL,'reserved')")
        .run(podId, operationKey, digest(request.route), row.grant_revision, maximumTokens);
      this.service.db
        .prepare('UPDATE managed_pods SET consumed_tokens=consumed_tokens+? WHERE pod_id=?')
        .run(maximumTokens, podId);
      return request.route;
    });
    const route = reserve.immediate();
    if (!route) return { state: 'reserved' };
    // The actual provider adapter must enforce maximumTokens at its remote request boundary.
    const result = await provider(route, maximumTokens);
    if (
      !Number.isSafeInteger(result.consumedTokens) ||
      result.consumedTokens < 0 ||
      result.consumedTokens > maximumTokens
    ) {
      throw new Error('provider-usage-contract-violation');
    }
    this.service.db
      .transaction(() => {
        this.service.db
          .prepare(
            "UPDATE managed_provider_allowances SET state='observed',actual_tokens=? WHERE pod_id=? AND operation_key=?",
          )
          .run(result.consumedTokens, podId, operationKey);
        this.service.db
          .prepare('UPDATE managed_pods SET consumed_tokens=consumed_tokens-? WHERE pod_id=?')
          .run(maximumTokens - result.consumedTokens, podId);
      })
      .immediate();
    return { state: 'observed', value: result.value };
  }
  snapshot(installation: string, podId: string) {
    const row = this.service.row(installation, podId);
    const request = JSON.parse(row.request_json) as ManagedPodRequest;
    const usage =
      'mode' in request.effectiveGrant.budget
        ? (this.service.db
            .prepare(
              'SELECT count(*) AS n, count(actual_tokens) AS known FROM managed_provider_requests WHERE pod_id=?',
            )
            .get(podId) as { n: number; known: number })
        : null;
    return {
      ...(usage ? { tokenUsageKnown: usage.n > 0 && usage.known === usage.n } : {}),
      specDigest: row.execution_spec_digest,
      observedAt: this.service.now(),
      consumedTokens: row.consumed_tokens,
      revoked: Boolean(row.revoked || row.stop_requested || this.service.expired(row)),
    };
  }
}

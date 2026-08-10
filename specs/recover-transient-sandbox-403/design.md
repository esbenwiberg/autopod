# Design — Recover transient Azure Sandbox 403 failures

## Blast radius

### Shared and persistence contract

- `packages/shared/src/types/pod.ts` — structured pod infrastructure failure and recovery
  counter.
- `packages/daemon/src/db/migrations/` — additive pod columns with legacy defaults.
- `packages/daemon/src/pods/pod-repository.ts` — read/update serialization.

### Azure adapter

- `packages/daemon/src/containers/sandbox-api-client.ts` — daemon-local typed infrastructure
  error contract.
- `packages/daemon/src/containers/azure-sandbox-api-client.ts` — exhausted-empty-403
  classification.

### Lifecycle and decision surfaces

- `packages/daemon/src/pods/pod-manager.ts` — evidence gate, cleanup, delayed requeue,
  exhaustion, Resume, and provider-attempt accounting.
- `packages/daemon/src/pods/readiness-review.ts` — infrastructure-unavailable readiness.

Co-located test files provide the durable proofs.

## Seams

1. **Azure response to typed infrastructure error** — brief 01 owns the distinction between
   exhausted empty data-plane 403 and deterministic HTTP errors.
2. **Typed error to persisted pod state** — brief 01 owns the shared shape, migration, and
   repository round trip.
3. **Persisted state to lifecycle recovery** — brief 02 consumes the brief-01 contract and
   owns automatic recovery, explicit Resume, and terminal behavior.
4. **Persisted state to readiness** — brief 02 maps only the current infrastructure failure to
   `needs_review`; ordinary validation absence remains unchanged.

## Contracts

Brief 01 owns a shared shape equivalent to:

```ts
export interface PodInfrastructureFailure {
  source: 'azure-sandbox';
  code: 'AZURE_SANDBOX_TRANSIENT_FORBIDDEN';
  phase: 'setup' | 'agent';
  statusCode: number;
  diagnostics: Record<string, string>;
  safeAgentRestart: boolean;
  recoveryDisposition:
    | 'automatic_retry_scheduled'
    | 'automatic_retry_exhausted'
    | 'agent_execution_ambiguous'
    | 'sandbox_cleanup_unconfirmed';
  occurredAt: string;
  retryNotBefore: string | null;
}
```

`Pod` gains:

```ts
infrastructureFailure: PodInfrastructureFailure | null;
infrastructureRecoveryCount: number;
```

Names may be adjusted to match local naming, but the semantics, bounded diagnostic policy,
legacy defaults, and separation from validation failures are fixed.

The daemon-local sandbox error must carry the stable code
`AZURE_SANDBOX_TRANSIENT_FORBIDDEN`, retryability, and safe diagnostics without exposing raw
headers or bodies.

Resume adds the response action `retry-agent`. Existing clients decode the action as an
opaque string.

## Recovery flow

```text
empty data-plane 403 budget exhausted
                |
      typed infrastructure error
                |
      runtime event observed? ---- yes ---> failed, human-gated
                |
               no
                |
      auto budget available? ----- no ----> failed, exhausted
                |
               yes
                |
      old sandbox deletion proven? no ----> failed, retain exact ID
                |
               yes
                |
  persist count=1 + retryNotBefore; queue safely
                |
       wait remaining cooldown
                |
       provision different sandbox
```

## Reference reading

- `research.md` — factual current-state map and incident evidence.
- `plan.md` — approved implementation and proof strategy.
- `packages/daemon/src/containers/azure-sandbox-api-client.ts` — current transport retry and
  safe diagnostics.
- `packages/daemon/src/pods/pod-manager.ts` — current generic failure, Rework, Resume, and
  validation infrastructure paths.
- `packages/daemon/src/pods/local-reconciler.ts` — fresh-container recovery precedent.
- `packages/daemon/src/pods/pod-queue.ts` — queue-safe deferred requeue.
- `packages/daemon/src/pods/readiness-review.ts` — current validation-unknown decision.
- `docs/decisions/ADR-031-azure-container-apps-sandboxes-backend.md` — preview-backend and
  no-rerouting constraints.
- Repository `AGENTS.md` migration-numbering warning — recheck the highest prefix before adding
  a migration.

## Decisions

- ADR-031: Azure Container Apps Sandboxes backend (existing).
- No new ADR: the recovery follows existing lifecycle and validation-infrastructure precedents
  and is additive/reversible.

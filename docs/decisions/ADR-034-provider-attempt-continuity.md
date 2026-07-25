# ADR-034: Preserve provider continuity with immutable same-pod attempts

## Status

Accepted

## Context

A provider subscription or quota limit can interrupt useful work without invalidating the pod,
its worktree, or its intended outcome. Mutable pod-level runtime, model, session, token, and cost
fields cannot explain a run that crosses providers. Treating each continuation as a new pod would
lose lifecycle continuity and multiply throughput, quality, and reliability outcomes.

Automatic switching also needs a narrow authority boundary. Provider errors can be transient,
authentication-related, unavailable-service failures, or unknown text; a generic 429 or unfamiliar
message is not sufficient evidence of subscription exhaustion. Profile-specific policy and reusable
provider-account defaults need deterministic precedence.

## Decision

Represent each contiguous provider execution segment as an append/close-only provider attempt under
one pod ID. An attempt fixes provider account, runtime, model, profile reference, native session,
timestamps, terminal classification, tokens, cost, and optional handoff reference. Once closed, its
identity and accounting are immutable. Pod-level runtime, model, session, token, and cost fields
remain compatibility projections; legacy pods without attempt rows continue to use those fields.

Provider/model analytics attribute usage and cost to attempts. Logical pod funnels and quality or
reliability denominators continue to count one terminal pod. When attempts exist, aggregate pod
tokens and cost equal the sum of its attempts; attribution queries must not multiply lifecycle
outcomes by joining the attempt ledger.

Automatic failover is authorized only by an explicitly configured policy. A provider account may
define a reusable ordered default chain. A profile's non-null policy replaces that default in full:
an empty target list explicitly disables automatic failover, while `null` inherits the account
default. The two policies never merge implicitly.

Only adapter-classified terminal `quota_exhausted` evidence marked definitive, after provider-native
transient retries settle, may trigger automatic failover. Authentication errors, transient
throttling, provider unavailability, and unknown evidence fail closed and do not switch providers.
Without an eligible configured target, Autopod preserves the source attempt, native session, pod,
and worktree and pauses for an operator-directed continuation.

Cross-provider continuation starts a new native provider session through normal queue-driven
provisioning under the same pod ID. It carries only a sanitized, bounded Autopod-managed handoff;
vendor-hidden reasoning, credentials, raw audit events, and unbounded transcripts are excluded.

## Consequences

Easier:

- Operators retain one pod, worktree, lifecycle, and attributable history across provider limits.
- Runtime, model, token, and cost reporting reflects the providers that actually performed work.
- Existing analytics and historical pods remain readable through explicit compatibility fallbacks.
- Account defaults are reusable while profile owners retain clear replacement authority.

Harder:

- Every execution path must transactionally close one attempt before opening the next.
- Analytics must deliberately separate attempt attribution from logical pod outcome denominators.
- Adapters require fixture-backed conservative classifiers and must tolerate upstream message drift.
- Compatibility projections must remain synchronized with the active or latest immutable attempt.

Committed to:

- Append/close-only provider attempt identity and accounting.
- One logical pod outcome regardless of the number of provider attempts.
- Configured, bounded failover authority with replace-not-merge profile precedence.
- Fail-closed classification for ambiguous, transient, authentication, and availability failures.
- Queue-driven same-pod continuation with sanitized handoff and preserved worktree state.

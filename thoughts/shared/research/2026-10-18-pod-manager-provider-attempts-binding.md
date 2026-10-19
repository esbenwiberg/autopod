---
date: 2026-10-18T22:59:42+02:00
researcher: Codex
git_commit: 4bb85f187a0add20c787d3c04b6f87ec5fed0dd7
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 21: provider attempts and binding"
tags: [research, codebase, pod-manager, provider-attempts]
status: complete
last_updated: 2026-10-18
last_updated_by: Codex
---

# Slice 21 research: provider attempts and binding

## Research question and current state

Continue the remaining-slices goal by locating the provider-attempt/binding ownership
still inside the manager. Slice 20 is complete at this baseline; 14 numbered milestones
remain. The complete goal is still active through Slice 34, under the continuation
cadence recorded in the remaining roadmap and Slice 20 plan.

The manager has 14,371 lines. Nineteen provider-context functions, one failover-result
type and one MAX credential-lineage map belong to Slice 21's baseline inventory.
The existing provider-attempt repository and account store supply persistence/account
operations; the manager helpers still choose identities, snapshots, routes and attempts.
No Slice 21 implementation has started in this research checkpoint.

## Attempt lifecycle

In packages/daemon/src/pods/pod-manager.ts:
- providerForAttempt :1866–1880 prefers pod provider snapshot, account lookup, profile
  provider, then runtime compatibility fallback.
- redactedProfileSnapshot :1882–1930 recursively nulls credential-bearing keys and
  removes URL userinfo/query/fragment. profileReferenceForAttempt :1932–1938 hashes
  the supplied redacted snapshot. nativeSessionId :1940–1945 selects runtime ids.
- reasoningEffortFromSnapshot :1947–1958 accepts the known effort values;
  resolvedReasoningEffort :1960–1965 uses snapshot, profile, then auto.
- ensureProviderAttempt :1967–2029 reads the live attempt repository, retains active
  snapshot identity, rejects requireNew/mismatch, captures legacy nonzero usage into
  a completed segment when needed, and opens the next segment.
- rotateProviderAttemptForFreshSegment :2031–2075 checks optional active run token,
  current predicate and ordinal. An unstarted handoff continuation stays in place;
  otherwise the old segment closes aborted, a fresh segment opens and the current
  run's providerOrdinal updates.
- closeProviderAttempt :2077–2101 checks expected ordinal and closes with current
  native session, observed attempt usage, classification and handoff reference.

provider-attempt-repository.ts exposes open/update/close, active snapshot/history,
ordinal fences and audited telemetry projections. Its OpenProviderAttempt retains a
credential-redacted snapshot and profile reference; ProviderAttemptSupersededError
has code STALE_PROVIDER_ATTEMPT and HTTP status 409. The snapshot validator rejects
non-redacted sensitive fields (source :1–150).

## Binding and failover

- isCompatibleTarget :2332–2359 uses captured catalog/account credentials, including
  generic Pi adapters and the Foundry API surface.
- ProviderFailoverSelection :2361–2376 represents selected, unavailable, no-policy,
  disabled, exhausted or ineligible outcomes. selectProviderFailoverTarget
  :2378–2426 reads profile policy and live attempt history, respects maxHops/used
  targets and returns the first eligible unattempted account/runtime/model target.
- Diagnostic helpers :2428–2470 bound/escape account/runtime/model text and render
  typed outcome messages. These are existing behavior, not new safety policy.
- profileForProviderTarget :2472–2502 checks the account/adapter then overlays the
  selected account, provider, runtime and model onto the supplied profile.
- resolveEffectiveBoundProfile :2504–2603 checks immutable launch route/accounts,
  active/latest attempt identity and queued pod snapshots before returning the
  reconciled profile. Mutable profile defaults do not replace a retained binding.
- openProviderTargetAttempt :2605–2638 retains reasoning, projects the target pod
  identity, redacts/hash-references its profile and opens the selected segment.

The account store interface is in provider-accounts/provider-account-store.ts:1–32.
Auth resolution is delegated to providers/auth-resolution.ts. Launch account checking
is delegated to configuration/agent-route-resolution.ts. These helpers do not dispatch
paid provider work themselves.

## State and initialization relationships

maxCredentialLineageByPod is constructed at manager :3021. The remember/forget helpers
at :3172–3182 mutate this same map. Worker credential and reviewer context composition
consume it at :4776/:4789.

Attempt rotation reads activeAgentRuns, constructed at :3678. The early runtime resume
context is composed at :2907 and captures resolvedReasoningEffort. The merge-poller
startup call is :4644. These actual initialization/capture points constrain the next
plan; the original helper declarations are hoisted while future factory values are not.

Provider account/catalog/profile store references are captured by the manager's initial
destructuring. Attempt repository and launch configuration reads remain through the
original deps object. Methods on those service objects are looked up when each helper
calls them. The selected functions are synchronous; no new async boundary is present.

## Existing evidence

The full manager suite at this exact source passes 1,192 tests, including provider
binding/failover, snapshotted reasoning, account initialization/closure, handoff,
forced rework and stale ownership cases. Relevant case groups occur around manager
.test.ts :5104–6531, :14126, :18592–18728 and :19401. Existing affected suites include
provider-attempt-repository, provider-account-store, auth/environment, launch snapshots,
worker credentials and runtime resume context.

Slice 20 qualified the same source bytes with 97 affected suites (3,406 cases), full
uncached 8,577 Vitest cases, 35 script checks and ten existing gated skips. Those are
baseline results, not Slice 21 implementation results. Existing assertions can be
reused only while the baseline source/test hashes still match.

## Handoff

Current-state research is complete. Next: write the concrete Slice 21 plan from these
live declarations, preserving method lookup, initialization, identity/redaction,
ordinal/lineage and existing call/await behavior; then continue the user-authorized
remaining sequence. No source/design/policy/schema decision is made by this report.

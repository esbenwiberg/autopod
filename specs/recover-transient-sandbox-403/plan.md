# Plan — Recover transient Azure Sandbox 403 failures

## Overview

Add a typed, persisted pod-infrastructure failure contract and use it to perform one safe,
delayed, fresh-sandbox recovery when Azure's preview data plane exhausts empty-403 retries
before the runtime yields any agent event. A repeated or ambiguous failure remains failed
and human-gated.

## Desired end state

1. Empty data-plane 403 exhaustion is machine-distinct from RBAC denial.
2. An eligible pod receives exactly one fresh-sandbox recovery after a durable 30-second
   cooldown.
3. The old sandbox must be proven absent before its identity is replaced.
4. Runtime activity, unsafe workspace state, or exhausted budget prevents automatic
   recovery.
5. Explicit Resume of a proven pre-agent infrastructure failure reruns the original task
   and resets the automatic budget; Rework also resets it.
6. The terminal pod and readiness surfaces name Azure infrastructure without implying
   provider failure or risky code.

## What we are not doing

- Changing the six-attempt request retry budget.
- Retrying a non-empty or ARM-plane 403.
- Adding a pod status, profile field, or state-machine transition.
- Automatically switching region or execution target.
- Building a fleet-wide regional circuit breaker.
- Automatically restarting after any runtime event or uncertain workspace preservation.
- Adding desktop or mobile UI code.

## Implementation approach

### 1. Typed adapter failure

Introduce a daemon-local sandbox infrastructure error carrying a stable code, retryability,
and the already-allowlisted Azure diagnostics. The Azure request helper throws it only when
all of these are true:

- the request used the sandbox data plane;
- the final response is HTTP 403;
- the response body is empty; and
- the configured transport retry budget is exhausted.

Other HTTP failures retain the current `AZURE_SANDBOX_HTTP_ERROR` behavior.

### 2. Persisted pod contract

Extend the shared pod contract with a nullable bounded infrastructure failure record and a
separate non-negative automatic-recovery count. The record owns:

- source and stable error code;
- operator phase (`setup` or `agent`);
- HTTP status and safe Azure diagnostics;
- whether fresh agent execution is proven safe;
- recovery disposition (`automatic_retry_scheduled`, `automatic_retry_exhausted`,
  `agent_execution_ambiguous`, or `sandbox_cleanup_unconfirmed`);
- occurrence time; and
- a nullable `retryNotBefore` timestamp.

Add SQLite columns with safe legacy defaults and repository round-trip support. Keep raw
response bodies, credentials, and unrestricted headers out of persistence.

### 3. Eligibility evidence

Within each `processPod()` call, record whether the runtime iterator yielded any event.
Automatic recovery requires all of the following:

- sandbox execution target;
- the dedicated exhausted-empty-403 error;
- setup or agent phase;
- no yielded runtime event;
- no native runtime session;
- no provider-attempt session, tokens, or cost;
- no task summary, validation result, or PR;
- an uncompromised host worktree; and
- automatic recovery count below one.

The local runtime-event flag is authoritative for the active process. Persisted fields are
defense in depth and support later Resume routing.

### 4. Fresh-sandbox recovery

For an eligible error:

1. Increment lifecycle generation before awaiting cleanup.
2. Abort/close the never-started provider attempt as `aborted`.
3. Stop preview/sidecar/network resources and require confirmed deletion or absence of the
   old sandbox.
4. If cleanup cannot be proven, retain the exact container ID and fail with
   `sandbox_cleanup_unconfirmed`.
5. Otherwise update the pod directly to `queued`, clear the container ID, retain the host
   worktree through `recoveryWorktreePath`, increment the recovery count, and persist
   `retryNotBefore = now + 30 seconds`.
6. Request `requeueAfterCurrent()` so the current queue ownership is released first.
7. At the next `processPod()` entry, wait only the remaining cooldown, then re-check status
   and lifecycle ownership before provisioning.

The cooldown duration needs a dependency seam so focused tests can use zero delay. The
persisted timestamp, not an in-memory timer, is the source of truth across daemon restart.

### 5. Exhaustion and explicit recovery

If the replacement sandbox encounters the same eligible error, retain recovery count one,
persist `automatic_retry_exhausted`, and transition to `failed`. Do not queue a third
sandbox.

For a failed pod whose persisted failure says fresh agent execution is safe, `resumePod()`:

- increments lifecycle generation and safely cleans any retained sandbox;
- resets the infrastructure failure and recovery count;
- queues the existing host worktree for a normal fresh agent spawn with the original task;
- does not set `skipAgent` or a validation-only path; and
- returns action `retry-agent`.

Force Rework also clears the two infrastructure fields. Failures with runtime activity or
uncertain cleanup retain the existing human-controlled Rework/Fix Manually choices and do
not gain automatic execution.

### 6. Readiness and diagnostics

When the current terminal failure is the structured pre-agent Azure infrastructure failure
and no validation exists, produce a validation-area `needs_review` warning explaining that
validation was unavailable. Do not emit `validation-unknown`. Ordinary missing validation
must remain risky, and unrelated risky findings must still dominate the top-level result.

Continue emitting a concise failure reason/activity message with the latest safe Azure
request ID, automatic attempt count, and whether recovery was scheduled or exhausted.

## Checkpoints

1. Land the typed adapter error plus shared/SQLite persistence and focused round-trip tests.
2. Consume that contract in pod lifecycle recovery, Resume, provider-attempt accounting,
   and readiness with focused behavioral tests.

These are separate briefs because the shared/on-disk contract is a real dependency gate.

## Test strategy

### Adapter discrimination

Feed the same endpoint empty 403s through exhaustion and assert the dedicated retryable
infrastructure type plus safe request diagnostics. Feed a non-empty RBAC 403 and assert it
remains deterministic. The obvious broken implementation returns the same generic code for
both and fails this fact.

### Persistence defaults and round trip

Load a legacy/default pod and assert `null` failure plus zero recovery count. Persist a
scheduled recovery with diagnostics/cooldown, reload it, and assert semantic equality. The
obvious broken implementation loses the cooldown or treats old pods as already retried.

### Exactly one fresh sandbox

Make the first sandbox throw the typed error before yielding an event, confirm old-sandbox
deletion, and make the replacement throw it again. Assert two distinct sandbox provisions,
one delayed lifecycle requeue, count one, and terminal exhaustion without a third sandbox.
The current implementation provisions only once; an unbounded implementation provisions a
third.

### Safety gates

Yield one runtime event before the typed error and assert there is no automatic requeue.
Separately make old-sandbox cleanup unprovable and assert the exact container ID remains and
no replacement is provisioned. An over-broad retry implementation fails both facts.

### Explicit Resume

Start from a terminal exhausted pre-agent failure, invoke Resume, and drive the queued pod.
Assert a fresh runtime spawn receives the literal original task and validation does not run
first. The current broken implementation calls forced revalidation and fails this fact.

### Readiness differentiation

Compare two failed pods without validation: one with the current structured infrastructure
failure and one ordinary pod. Assert `needs_review`/infrastructure-unavailable versus
`risky`/validation-unknown. A blanket suppression or unchanged readiness fails the fact.

## Risks and mitigations

- Direct `running`/`provisioning` to `queued` recovery bypasses normal transitions. Keep it in
  one named helper, increment lifecycle generation first, and emit an explicit status event,
  following restart recovery precedent.
- The Azure data plane may reject sandbox deletion during the same incident. Treat deletion
  proof as a safety gate and retain the ID on failure.
- Runtime adapters emit different first events. Observe the generic `AgentEvent` iterator,
  not runtime-specific session messages.
- Redundant persisted state can drift. Keep the numeric budget authoritative and use the
  failure disposition to describe the current recovery stage.
- Migration prefixes collide silently. Recheck the directory immediately before creating the
  migration.

## Rollback

Reverting runtime behavior stops new automatic recoveries. The additive nullable JSON and
integer columns can remain harmlessly on existing databases; older binaries ignore them.

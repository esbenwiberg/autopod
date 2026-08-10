# Research — Recover transient Azure Sandbox 403 failures

## Incident evidence

On 2026-08-10, pod `nursing-limpet` failed before any Codex session or token use when
Azure Container Apps Sandboxes returned an empty HTTP 403 from
`executeShellCommand`. The response exposed only safe diagnostics, including request ID
`02de0d4185fe0b0367ac2c60fb098883`. The request had already exhausted Autopod's
six-attempt transport retry budget.

An explicit retry later failed during sandbox setup on a file `PUT`, again after the
transport retry budget and with a different request ID,
`94f339364641a709364bb1ad85e557f1`. This established that the observed failure was not
limited to one command endpoint or one request.

The pod had zero provider tokens, no native Codex session, no task summary, and no
agent-authored diff. The daemon verified the host workspace checkpoint after the first
failure.

## Current Azure request behavior

`packages/daemon/src/containers/azure-sandbox-api-client.ts` owns Azure ARM and
data-plane requests. Its request loop:

- obtains the appropriate ARM or Dynamics Sessions access token;
- retries HTTP 429 responses with bounded provider-aware backoff;
- retries empty data-plane HTTP 403 responses through the same six-attempt budget;
- does not retry non-empty 403 responses or ARM-plane 403 responses; and
- preserves an allowlisted set of Azure response headers in the final error text.

After the final empty 403, `throwAzureHttpError()` throws the same
`AZURE_SANDBOX_HTTP_ERROR` used for deterministic failures. The empty transient form is
therefore no longer machine-distinguishable once it leaves the API adapter.

The existing tests in
`packages/daemon/src/containers/azure-sandbox-api-client.test.ts` prove successful
empty-403 retry, immediate non-empty-403 failure, retry exhaustion, and safe diagnostic
redaction. They do not prove a distinct typed outcome after exhaustion.

## Current pod failure flow

`packages/daemon/src/pods/pod-manager.ts:processPod()` tracks a visible operator phase of
`setup`, `agent`, or `completion`. Errors from setup and from asynchronous runtime
iteration reach one generic catch. That catch:

- formats a generic operator failure reason;
- emits a fatal activity event;
- tries to persist rotated runtime credentials;
- checkpoints and cleans a sandbox when the visible phase is `agent`;
- closes the provider attempt as failed; and
- transitions the pod to `failed`.

This flow has no pod-level infrastructure classification. Provider-attempt reporting
therefore shows an unknown provider failure even when the provider process never started.

`lastAgentEventAt` cannot establish agent execution: `emitActivityStatus()` updates it for
orchestrator bootstrap messages such as sandbox creation and credential preparation. The
runtime iterator itself is the authoritative in-process boundary. The first value yielded
by that iterator is an agent event; an exception before any yield is pre-agent evidence.

Persisted defensive evidence also exists in the pod and provider-attempt ledger: native
session IDs, input/output tokens, cost, task summary, current provider-attempt native
session and accounting, worktree compromise state, and validation/PR state.

## Existing recovery patterns

`packages/daemon/src/pods/local-reconciler.ts` implements crash recovery. It increments a
persisted restart recovery count, kills the old container, cleans pod resources, updates
the pod directly to `queued`, retains the host worktree as `recoveryWorktreePath`, and
enqueues a fresh container. It deliberately bypasses ordinary state transitions because
recovery is not normal lifecycle progression.

`packages/daemon/src/pods/pod-queue.ts` exposes `requeueAfterCurrent()`. This remembers a
requeue requested from inside the active `processPod()` call and schedules it only after
the current queue processor releases the pod ID.

`lifecycleGeneration` fences stale asynchronous continuations. Force rework increments the
generation before destructive cleanup. The same ordering is required for an automatic
fresh-sandbox recovery.

The existing `recoveryCount` belongs to daemon restart recovery and has a three-restart
cap. Reusing it for provider infrastructure would mix two independent budgets.

## Current Resume and Rework behavior

`resumePod()` chooses the least expensive downstream recovery for an ordinary failed pod:
it retries PR delivery after passing validation or invokes forced validation-only
revalidation otherwise. That is correct after agent work, but incorrect after a pre-agent
infrastructure failure because the original task never ran.

Force Rework provisions a fresh container and fresh agent segment. Its current
`failedBeforeAgentWork` heuristic uses absence of validation, task summary, session IDs,
and PR state, but it does not have the original structured failure or direct runtime-event
observation.

## Validation infrastructure precedent

Validation already has `ValidationInfrastructureFailure`. The validation controller
retries typed retryable infrastructure failures with bounded backoff, does not send them
to the agent as correction feedback, does not consume the normal validation-attempt
budget, and parks exhausted failures for explicit Resume.

This precedent is validation-specific; storing a fake validation result for a failure that
occurred before the agent would misstate the lifecycle.

## Current readiness behavior

`packages/daemon/src/pods/readiness-review.ts` treats any decision-state pod without a
blocking validation result as risky and emits `validation-unknown`. For a pod that never
ran because Azure infrastructure was unavailable, this presents missing proof as evidence
of risky code rather than infrastructure unavailability.

Readiness already supports `needs_review` areas and warning findings. It can distinguish
the infrastructure case without adding a new readiness status or user interface.

## Persistence and client surface

Pods are persisted through SQLite migrations and
`packages/daemon/src/pods/pod-repository.ts`. The highest migration prefix observed during
research was `139`; the executor must recheck immediately before selecting the next prefix
because duplicate migration numbers are silently skipped.

The full pod JSON is based on the shared `Pod` type. Desktop decoding ignores additional
JSON fields, failure presentation already uses `failureReason`, and readiness is already a
structured surface. `ResumeResponse.action` is decoded as a string. The behavior can
therefore become truthful without a desktop or mobile source change.

## Governing constraints

- `docs/decisions/ADR-031-azure-container-apps-sandboxes-backend.md` records that Sandboxes
  is a preview backend and forbids automatic rerouting between execution targets.
- Existing transport retries are bounded and distinguish empty from non-empty 403s while
  the response is available.
- Recovery must retain exact container/worktree identity when cleanup or preservation is
  uncertain.
- No pod status should be added: `failed` is the truthful terminal state after exhausted
  infrastructure recovery; `review_required` is validation-specific and `paused` denotes a
  suspended live worker.

# Recovering failed validation

If a task still displays `running` with unresolved worker ownership after restart,
use [Inspect stalled execution in the desktop](desktop-stalled-worker-recovery.md)
first. Its explicit stop-and-retain action is not validation repair or a pass;
existing infrastructure, guidance and retry-admission fences remain in force.

The desktop's current Validation tab exposes two different operations:

- **Fix validation** requests a coding-worker correction followed by normal validation
  and the task's configured delivery policy. Established worker admission, task-wide
  retry permissions, and budgets still apply.
- **Retry checks** repeats validation on the retained resource without starting a coding
  worker. Passing checks stop at `validated`: this operation does not publish source,
  create a PR, start dependent steps, run publication-linked advisory QA, auto-approve,
  or merge. Normal
  approval remains a separate action, including when auto-approve is configured.

Commands can change tracked files (for example an install updating a lockfile).
“Without a coding worker” does **not** promise a read-only filesystem.

Controls display pending requests, blocking reasons, and execution/admission errors.
A lost HTTP response triggers observation, not an automatic second POST. Current
failures have controls; selecting a historical validation attempt does not.
**Override validation…** remains a separate, reason-required exceptional action.

## Validation waivers and pending human decisions

Normal approval is blocked by an unanswered human decision even when validation
is marked **waived**. An approval reason is not an answer to that decision.
Readiness shows the pending decision ID and routes to the question or Validation.

An explicit human **Override validation…** records the override reason and actor
in both the escalation audit and durable decision journal, atomically with the
waiver and transition to `validated`. A failed transition leaves the question,
waiver and decision receipt unchanged. This does not queue agent guidance or
rerun this pod's worker. Existing dependency scheduling remains unchanged for a
new transition to `validated`. Normal downstream approval guards still apply;
retain any PR-only/no-merge restrictions in the override reason.

Older overrides may have left a pod `validated` with no visible question but a
pending durable decision. For this state, Validation offers **Reapply validation
decision…**. Review the saved waiver and supply a fresh human reason. The original
waiver text (including PR-only/no-merge restrictions) is retained alongside the
new reason. The daemon
requires the exact saved question, belonging to this pod, and its prior human
force-approval audit. Missing, mismatched or unrelated evidence remains blocked;
there is no automatic inference from a cached waiver and no journal deletion.
Reapplication does not trigger dependent steps again. Installing this fix does
not repair any live pod; reapplication remains an explicit operator action.

## Authenticated recovery API

`GET /pods/:podId/validation-recovery` returns eligibility for both actions,
`generation`, `validationTimestamp`, `activeAction`, and `lastError`.
Eligibility is calculated by the daemon, not inferred from an attempt label.

`POST /pods/:podId/validation-recovery` requires a human identity and a body like:

```json
{
  "action": "retry-checks",
  "expectedGeneration": 3,
  "expectedValidationTimestamp": "2026-10-27T17:10:00.000Z"
}
```

It returns `202` with `{ "ok": true, "accepted": true }`.
Execution is detached from the HTTP connection. Poll GET to observe it. Identical
in-flight requests coalesce; competing actions and stale generations/results
conflict. Request errors remain available for the same generation and result.
In-flight/error observations are process-local, not a durable cross-restart job
queue. Restart recovery continues to use established pod/ledger state; the client
must inspect fresh state instead of assuming an accepted request finished.

Both operations refuse unresolved human decisions, compromised/missing worktree references,
and known unverified validation termination or incomplete cleanup. Worker execution
and reviewer accounting fences are not waived. Retry checks additionally requires
an existing retained resource; disappearance during recovery parks the pod rather
than silently queuing a new worker through a publication-capable workflow.

A per-cycle “attempt 1 of 3” label is not three new task-wide retry grants. When
admission requires human authorization, use the explicit retry-authorization card;
these controls neither authorize nor reset allowances automatically.

## Retained source ownership

An explicit [retained continuation](retained-pod-continuation.md) owns its selected
source through checks and subsequent approval. Ordinary Fix validation/Rework and
Retry checks are then unavailable, including after a failed check: they cannot
replace the resource, reset counters or detach that source. Inspect the durable
operation and current execution first. Passing source-bound checks/review still
requires fresh human approval; automation cannot consume the earlier approval.

## Incomplete validation processes

Fatal allocation diagnostics now park Docker validation as
`PROCESS_MEMORY_EXHAUSTED`, like the existing sandbox allocation hold, instead
of sending incomplete checks back to a coding agent. A failed test command with
Vitest's unhandled pool-error and unexpected-worker-exit diagnostics parks as
`VALIDATION_RUNNER_CRASHED`. These are failed/incomplete validation, not evidence
that code is innocent, that kernel OOM occurred, or that another execution is safe.
Ordinary assertion failures retain coding-correction semantics; successful commands
printing diagnostic fixtures are not reclassified. Existing source, termination,
stage-retry and independent-review guards remain in force.

New Docker workers use Docker init to reap orphan tool children. An existing
container is not retrofitted by deployment: preserve it and select supported fresh
execution after diagnosis rather than clearing a hold or manually deleting it.

This repository's daemon test script defaults to a bounded 4 GiB Node old-space
heap, propagated to forked test workers. It retains explicit `NODE_OPTIONS`
(including smaller budgets), every test, the single-worker default and all exit
statuses. This addresses Node 22's approximately 2 GiB default observed in the
8 GiB self-hosting runner; it does not prove the absence of a code/test leak or
make a failed run pass. Qualify container capacity separately. Frozen worker
source/commands do not acquire this script change automatically.

The opt-in reaping fixture exercises the real manager, 2,675 orphan tool processes
and the original incident's six-second cleanup deadline, with an explicit cached
Linux image containing `autopod`, Node and `setsid`:

```sh
AUTOPOD_DOCKER_REAPING_FIXTURE_IMAGE=sha256:... \
AUTOPOD_DOCKER_REAPING_FIXTURE_SOCKET=/path/to/local/docker.sock \
npx pnpm --filter @autopod/daemon exec vitest run src/containers/docker-worker-reaping.docker.test.ts
```

It creates only its own network-disabled, resource-bounded container and removes
it in cleanup; it neither mounts host workspaces nor probes production resources.

## Diagnostics

Worker feedback retains bounded log head **and tail**. The desktop lifts decisive
lint diagnostics (including uncovered capsule commits) out of noisy successful
capsule output and into the summary and lint panel. Complete retained output remains
available through the existing log expansion.

## Follow-up work, not implemented by this change

- Mutation detection and capsule/source closure before delivery checkpoints.
- Durable recovery supervision/backoff and automatic bounded repair across the
  distinct trigger, Resume, and validation-only paths. Explicit checks-only retry
  intentionally does not become an automatic coding loop.
- Preserving reports before sandbox suspension and recovering their contents
  when the sandbox cannot be restored. Exact-source external delivery observation
  is now covered by [external-delivery-recovery.md](external-delivery-recovery.md),
  with report recovery explicitly pending and original resources retained.

This change does not deploy a daemon or mutate/recover any live pod.

## Ordinary repair handoff and infrastructure holds

The desktop repair handoff loads current-lifecycle eligibility from
`GET /pods/:podId/rework-v1/eligibility` for ordinary Rework, Revalidate and Resume.
The daemon projects `code: INFRASTRUCTURE_BLOCKED` before Rework-specific checks;
the desktop shows its reason and disables all three ordinary submissions. It does
not infer holds from failure text or disable every failed pod. Rework-only retry
authorization/cooldown restrictions do not prohibit the other two controls.

Loading or failed refreshes invalidate the previous eligibility. A legacy blocked
response without a stable code cannot identify a safe ordinary recovery path;
use a compatible daemon and refresh. Submission refreshes eligibility again, and
the backend's current admission and HTTP 409 remain final authority. A network
failure after POST retains an uncertain result and never automatically resubmits.
These source/UI changes do not deploy the daemon, clear any infrastructure hold,
or recover a live task. Qualified infrastructure recovery remains a separate,
explicit operator workflow.

## Unverified execution settlement and recovery budgets

Use [validation execution recovery](validation-execution-recovery.md) when an unverified
execution blocks both controls. The read-only `ap reconcile-validation <full-pod-id> --json`
command explains exact ownership and legacy-evidence eligibility. Unsupported destructive
reconciliation remains blocked: the current provider cannot prove final source/report
preservation while the original execution remains unknown. Original resources are retained.
The original failure and retry accounting remain unchanged. Budget selection, stage retry
authorization, code repair and checks-only execution are separate operations.
Installation does not itself request a worker retry or waive validation. Recovery
operations remain explicit operator actions.

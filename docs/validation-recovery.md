# Recovering failed validation

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

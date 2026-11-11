# Codex usage checkpoints and held-task recovery

Codex 0.160+ writes native `token_usage_record` JSONL envelopes before awaiting
model tool calls. Autopod meters these per-response records while the worker is
active, rather than waiting for `turn.completed` or `task_complete`.

- Each native invocation owns a fresh segment ID. Unique provider response IDs
  deduplicate compatibility projections and replay; a monotonic checkpoint
  sequence distinguishes queued older snapshots from inconsistent counters.
- Input includes cached input. Task token limits count input plus output, not
  input minus cache. Cache counters and catalogue cost estimates are attribution,
  not a provider invoice or proof of subscription-credit consumption.
- Pod, agent-phase and provider-attempt counters receive the same transactional
  delta. Final reports add only the unrecorded remainder, never the whole prefix
  again. Aborted runs retain measured spend as **partial**, not zero or complete.
- Native completion must agree with the deduplicated response sum and the native
  turn aggregate. A bounded finalization window drains same-session metadata when
  stdout overtakes the rollout writer. Metadata is streamed, not capped by total
  transcript size; oversized metadata records and missing/corrupt final proof
  fail closed. Ordinary tool bodies are never replayed as accounting or activity.
- Local resumes use the saved append boundary where available. Restored/sandbox
  files retain the existing strict timestamp boundary; clock uncertainty is not
  permission to replay previous turns. One CLI invocation represents one native
  user turn; an unexpected second turn is an accounting fault, not a cursor reset.
- Runtime usage metadata is separate from the public `AgentEvent` activity union.
  Existing CLI/mobile activity consumers do not acquire a new wire event kind.

## Limits and termination

A hard token cap is checked against measured task-wide usage after each accepted
checkpoint. It does not reserve future provider spending: a model request or
transport delay can overshoot the remaining allowance before usage is observed.

The current run must still own the execution before it requests a usage stop.
The Codex usage-stop path requires a tracked native exec and verified process-group
termination; missing handles or uncertain stops retain an unresolved execution
claim. Stopping the worker does not delete its container or source.

Previously incomplete usage is not made complete by a later successful invocation.
Likewise, a new incomplete invocation can make a previously repaired pod partial;
the older repair records and provider history remain preserved.

## Inline review is not a budget escape

Under a finite hard cap, unavailable final worker accounting still refuses reviewer
reservation. During the same live worker this is reported as **deferred / NOT RUN**
(`REVIEWER_WORKER_USAGE_PENDING`), not a browser failure or a passing review.
Unverified termination still requires reconciliation, not ordinary deferral.

The worker may finish local checks and source work. Any required independent
review remains unsatisfied until a configured downstream review actually runs.
A skipped pre-submit result cannot supply a passing cached verdict. Requirements
not covered by downstream configuration remain pending; no acceptance Fact is waived.

## Existing failed tasks and images

This fix is prospective. It does not rewrite old counters, reconcile aborted runs,
change budgets, authorize a continuation, or grant access to telemetry-repair APIs.
A native prefix is only a lower bound when terminal evidence is absent. Legacy
`token_count` repair refuses native-response rollouts, rather than replacing their
newer measured spend with incomplete compatibility-only totals. Respect
operator/admin authorization and supported source-custody/recovery controls; never
replace unknown history with zero or start another task to escape a cap.

The Node 22/24 base Dockerfiles install real `procps` and assert `ps` availability.
Deployment alone does not rebuild a frozen worker image. Build and qualify the
replacement image, then explicitly select it through supported recovery controls.
Do not remove Stryker checks or patch the preserved source container in place.

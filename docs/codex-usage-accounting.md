# Codex usage checkpoints and held-task recovery

Codex 0.160+ writes native `token_usage_record` JSONL envelopes before awaiting
model tool calls. Autopod meters these per-response records while the worker is
active, rather than waiting for `turn.completed` or `task_complete`.

- Each native invocation owns a fresh segment ID. Unique provider response IDs
  deduplicate compatibility projections and replay; a monotonic checkpoint
  sequence distinguishes queued older snapshots from inconsistent counters.
- Input includes cached input. Task token limits count input plus output, with
  attributed cache reads weighted at 0.1x (see the operations reference); they
  never subtract cache entirely. Cache counters and catalogue cost estimates are
  attribution, not a provider invoice or proof of subscription-credit consumption.
- Pod, agent-phase and provider-attempt counters receive the same transactional
  delta. Final reports add only the unrecorded remainder, never the whole prefix
  again. Aborted runs retain measured spend as **partial**, not zero or complete.
- Native completion must agree with the deduplicated response sum and the native
  turn aggregate. Sandbox runs collect guarded session snapshots independently of
  stdout activity (every 10 seconds by default), so a busy stream cannot leave live
  usage stuck at an old host copy. Final stdout completion refreshes the sandbox
  snapshot within a separate bounded window (30 seconds by default), including
  when no host copy exists yet. Concurrent collectors coalesce; suspension,
  supersession and timeout fence late publication. Missing or unreadable sandbox
  proof never falls back to stdout totals. Local bind-mounted runs retain their
  one-second finalization window. Metadata is streamed, not capped by total
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
Extensible soft limits retain their existing terminal-check behavior: live counters
are persisted, but the current invocation is allowed to settle before pausing for
a user extension. Hard and non-extendable limits stop at live checkpoints.

The current run must still own the execution before it requests a usage stop.
The Codex usage-stop path requires a tracked native exec and verified process-group
termination; missing handles or uncertain stops retain an unresolved execution
claim. Stopping the worker does not delete its container or source.

A prospectively verified ordinary hard-budget stop closes its exact resource-bound
run with the `token_budget` reason, records stopped-worker settlement (not successful
completion), and preserves source before recording preservation. A failed capture or
unverified stop never supplies those receipts. Resume/revalidation cannot substitute
checks for interrupted coding. After adjusting budget and separately authorizing any
required retry, the desktop **Continue coding** handoff uses the existing durable
Rework request to continue the retained native session. It retains resource/source and
cumulative accounting, and permits one coding segment followed by checks/review without
automatic coding retry. Preparation failure retains the interrupted-coding guard and the original generation's
stop proof, so another explicit request can retry preparation without backfilling receipts.
Startup/queue machinery never automatically replays a pending retained continuation.
If a cap is first reported on a completed worker's final usage, there is no interrupted
coding turn: the task parks with a distinct completed-worker reason and may retry checks
after budget adjustment, rather than requiring a nonexistent live-stop receipt.
Historical missing receipts are not backfilled; see
[desktop task budgets](desktop/task-budgets.md).

Previously incomplete usage is not made complete by a later successful invocation.
Likewise, a new incomplete invocation can make a previously repaired pod partial;
the older repair records and provider history remain preserved.

## Recover committed Docker source after a final-proof refusal

The fatal activity reports a redacted `codexFinalProofRefusal` code; the daemon
records the same code against the exact worker run. A missing response or
terminal record, aggregate or sequence mismatch, and snapshot failures are
different observations, not explanations of what caused the provider to omit
proof. Measured usage remains partial. Neither a preceding **Agent completed**
event nor a final task summary is process-exit evidence.

1. In the desktop Recovery hub, choose **Inspect stalled execution…** (authenticated
   `GET /pods/:podId/stalled-worker-recovery`). For an eligible ordinary local
   Docker task, explicitly confirm the exact inspected request. If the
   container is still running, this may stop it once, but never removes it.
   Even after verified native exec termination, this control verifies the same
   Docker resource is stopped and seals a private workspace archive. An unknown
   resource, unresolved stop, conflicting ownership or mismatched preserved
   source blocks the seal; observe the same request rather than repeating a stop.
2. Run `ap retained-continuation POD --json`. It reports why checks remain
   blocked, or returns the exact sealed commit/tree and selection hash.
   Use [exact-source checks-only selection](retained-pod-continuation.md#checks-from-sealed-pre-validation-source)
   with that commit, generation and hash. Dirty/unverified source does not
   qualify. This does not start coding, repair usage, waive budget or retry
   rules, or satisfy independent review. If unknown final usage blocks a
   reviewer under a finite hard task cap, review stays pending under that
   existing accounting gate. When exact checks and independent review pass,
   **Validated** allows ordinary separate human approval (including PR-only
   publication); nothing is automatically pushed, and usage stays partial.

This is prospective and does not infer receipts for old refusals from a log or
summary. Other execution targets do not qualify for the Docker source-seal route.
Do not use Resume, Rework or provider continuation to replay a worker on this hold.

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

## Docker validation process resources

New Docker worker containers enable the engine's init/reaper so orphaned tool/test
children are collected instead of accumulating zombies behind `sleep` as PID 1.
Existing containers are unchanged; deployment does not retrofit their process tree.
The daemon test script defaults its Node old-space heap to 4096 MiB, preserving an
explicit `NODE_OPTIONS` override. Container RAM and per-process V8 heap limits are
separate; qualify aggregate runner capacity before increasing worker concurrency.
Real process-tree termination tests use the production termination ceiling and retain
their descendant-termination assertions.

Precise fatal allocation/JavaScript-heap signatures from a nonzero local Docker
validation command are recorded as `PROCESS_MEMORY_EXHAUSTED` infrastructure failures,
including a worker crash wrapped in exit 1. Sandboxes keep their existing
`SANDBOX_MEMORY_EXHAUSTED` code. Neither error claims a kernel OOM kill; ambiguous
memory wording remains an ordinary failure. Infrastructure failures park validation
rather than automatically asking a coding agent to repair repository code. Retained
failed tasks still need qualified supported recovery; this does not replay them.

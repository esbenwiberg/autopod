# #648 Claude turn finality: no mid-turn kills, bounded background wait, no validation of interrupted turns — Implementation Plan

## Approved decisions (parent, 2026-11-23)

1. **Background cap: 25 min** by default (`AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS`).
   **Watchdog ordering:** the cap stays below the stuck-pod watchdog. The runtime
   clamps the effective cap to `stuckThreshold − 3 min`. The threshold is resolved
   from the same `AUTOPOD_STUCK_RUNNING_THRESHOLD_MS`/30 min default as the watchdog,
   through a shared helper, so an override cannot invert the ordering. A test asserts
   the ordering for the defaults and for an override. Treating the hold as liveness
   was rejected: it would need runtime→heartbeat plumbing.
2. Exit 0 straight after a background-pending, unreported result → **interrupted**.
3. The hold is gated on "no `report_task_summary` in this invocation" → **yes**.
4. Cumulative `total_cost_usd` double counting → **out of scope**. The final report
   cites file:line for a follow-up issue.
5. **Interrupted turns must not lose work** (added condition, see the #670 interplay):
   - The fatal interrupted error carries a new optional marker
     `AgentErrorEvent.turnInterrupted?: true` (shared type, optional, like
     `usageIncomplete`).
   - The consumer settles the run with failure category `turn_interrupted`. After
     run accounting closes, and only for a verified, owned, failed run with that
     category, it settles the completion journal, runs the existing
     `preservePodWorkspace` (sync-back with its existing guards, the same owner the
     verified token-budget stop uses), and marks the journal `ready` with source
     preserved. A preservation failure is reported as a status line, and the
     container is retained.
   - The worker retry ledger treats a `turn_interrupted` settled run like a completed
     run for **manual** Rework admission (`worker-retry-history.ts` returns `null`, as
     it does for `quota_exhausted`). `ap rework` therefore works without
     `authorize-retry`, as it does today from Needs Review. Nothing auto-retries.
   - Rework teardown (`validation-trigger-workflow.ts`, preserve-before-kill) also
     preserves a **Docker** pod whose latest run was `turn_interrupted` but whose
     source was not preserved. It fails closed (`WORKSPACE_SYNC_FAILED`, container
     retained) as the sandbox branch does today. This is intentionally limited to
     interrupted turns. #670 owns the generalisation to every abnormal exit.
   - `ap resume` (validation-only) refuses an interrupted-turn pod and points to
     `ap rework`, the same pattern as `assertBudgetCodingNotInterrupted`.
   - Test: an interrupted turn → `failed`, `finalization.sourcePreservedAt` set, sync-back
     called, a following worker run admitted without authorization, Rework requeues
     with `recoveryWorktreePath` = the preserved worktree, and Resume is refused.
6. Worker instruction wording (Claude only): "Prefer foreground commands. If you
   background a long command, do not end your turn until it has finished and you have
   reported. Poll or wait for it instead."

Consequence: Phase 3 now includes the small consumer, shared-type, retry-ledger,
Rework and Resume changes listed above. The earlier "no consumer/shared change"
statement no longer holds.

## Overview

The Claude runtime currently treats the first stream `result` as the end of the
turn. A one-shot 30 s timer then force-closes the stream and kills the CLI, even
while it keeps producing a turn, and the forced kill is reported as a "Completed
turn retained". Validation then runs on an unfinished workspace.

This plan adds a Claude-specific turn-finality layer:
- A `result` is **held** until it is known to be final.
- Activity after a result cancels the finality timer instead of being cut off.
- Pending background tasks get a bounded wait for their notification.
- A turn that ended unfinished becomes a **fatal "turn interrupted" error** with
  an `ap rework` recovery path. The consumer already maps that to `failed` and skips
  validation.

A short Claude worker instruction adds defence in depth.

Research: `thoughts/shared/research/2026-11-23-648-claude-turn-end.md`.

## Current State Analysis

- `ClaudeRuntime.spawn/resume` (`runtimes/claude-runtime.ts:69-280`) pipeline:
  parser → enriched (stderr, session id, `sawComplete`) → `withIdleLivenessProbe` →
  `withPostCompleteGrace` (one-shot; `stream-grace.ts:46-98`) → `withObservedRuntimeExit`
  (5 s wait, then verified tree kill) → `exitEvents` (`:302-325`, "Completed turn
  retained" whenever any `complete` was seen before a forced kill).
- The parser (`claude-stream-parser.ts`) discards `system/task_*` and
  `background_tasks_changed`.
- The consumer (`pods/agent-event-consumption.ts`) keeps reading after `complete`.
  A later fatal error moves the pod to `failed` and makes the outcome `failed`, so no
  `handleCompletion` or validation follows (`agent-process-workflow.ts:737-744`,
  `operator-messages.ts:782-784`).
- Stuck-pod watchdog: 30 min of silence fails the pod (`workspace-watchdog.ts:33-36`).

## Desired End State

1. A `result` followed by more stdout activity in the same process is
   **intermediate**. The daemon does not arm a kill, does not let an intermediate
   result reach the consumer as a `complete`, and shows a status line ("Claude
   continued working in the same session after an intermediate result"). Its token
   and cost numbers are carried into the next released `complete`, so totals match
   today's summing.
2. A `result` written while **non-ambient background tasks are pending**, before the
   agent called `report_task_summary` in this invocation, and while the pod is
   `running` with no pending escalation, gets a bounded wait
   (`AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS`, default 25 min, clamped below the 30 min watchdog)
   for the CLI to continue. If the tasks finish and no new turn starts within the
   normal grace, or the cap expires, or the CLI exits without continuing, the turn is
   **interrupted**.
3. A final result with no pending background work (or with the predicate false, e.g.
   while awaiting a human) behaves exactly as today: held for at most the 30 s grace
   or until EOF, then released. A forced kill after it is still "Completed turn
   retained".
4. An interrupted turn yields the held/merged `complete` (accounting only), followed
   by a **fatal** error after verified termination, for example:
   `Claude ended its turn while 2 background tasks were still running and did not continue within 25 min; the daemon stopped it (exit code 143). The turn is incomplete: the workspace may hold unfinished edits and was not validated. Run \`ap rework <podId>\` to continue from the preserved worktree.`
   The consumer marks the pod `failed` with that reason, and no validation starts.
   A forced kill after an intermediate result with activity and no later final
   result gets the same treatment ("stopped while still working").
5. Claude worker instructions say not to end a turn while background work is
   pending.

Verification: the new runtime tests (intermediate result then tool events; background
wait then continue; cap expiry; notification without a continuation; awaiting-human
predicate) pass. Existing broad-earthworm and stream-grace tests pass, updated only
where the semantics deliberately change. `consumeAgentEvents` integration with a
fake runtime shows `failed` and no `handleCompletion` for an interrupted turn.

### Key Discoveries
- One `-p` process can write several results (`result_index`, `queued_turn_count`),
  and the CLI continues on background-task notifications (`background_wait`). This
  matches the observed second `system/init` in occurrence 1 (research §5; static
  evidence, unverified live).
- `background_tasks_changed` is an authoritative level signal: the full set, replace
  semantics, empty at process start. Edge frames cover older or partial emitters.
- A fatal error after a `complete` is already handled correctly by the consumer
  (pod `failed`, outcome `failed`, latest persisted terminal event is `error`).
  **No consumer, shared-type or migration change is required.**

## What We're NOT Doing

- No change to Codex/Copilot/Pi runtimes or to the generic `withPostCompleteGrace`
  (other runtimes keep using it unchanged).
- No auto-resume "nudge" turn after an interrupted turn. The bounded wait plus a clear
  failed state with `ap rework` meets the outcome. A nudge would need new consumer
  orchestration and retry budgeting (possible follow-up).
- No fix for the pre-existing cumulative-`total_cost_usd` summing. Parity is kept by
  summing held intermediate results exactly as the consumer does today. Flagged as a
  follow-up.
- No `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` / `session_state_changed` dependency.
  Its version availability is unverified (future refinement).
- #663 root causes 1 and 3 (Docker divergence after rebase, force-approve of
  compromised worktrees) belong to another worker.
- `validation-review-source.ts` is unchanged. Interrupted turns no longer reach it.

## Implementation Approach

A Claude-only `ClaudeTurnFinality` state machine sits between the parser and the
existing enriched generator. It receives raw NDJSON frames through a new optional
parser observer hook, and receives mapped events by wrapping the parser iterable. It
owns the post-result timer, replacing `withPostCompleteGrace` for Claude only. It
force-closes stdout/stderr the same way the grace timer does today. Termination stays
in `withObservedRuntimeExit`. `exitEvents` classifies the outcome using the finality
verdict. Spawn and resume share one private pipeline method, which removes the current
duplication.

## Phase 1: Observe Claude background-task frames

### Changes
**File**: `packages/daemon/src/runtimes/claude-stream-parser.ts`
- Export the raw frame type (`ClaudeStreamEvent`) and add an optional 4th parameter to
  `parse(stream, podId, logger, observe?: (raw: ClaudeStreamEvent) => void)`, called
  synchronously after each successful `JSON.parse` and before mapping. Mapping output
  stays unchanged.

**File**: `packages/daemon/src/runtimes/claude-turn-finality.ts` (new)
- `ClaudeBackgroundTasks`: a set of pending background task ids built from:
  - `task_started` (added when `is_backgrounded !== false` and not `ambient`/`skip_transcript`).
  - `task_updated` (`patch.is_backgrounded === true` → add when known non-ambient;
    terminal `patch.status` → remove).
  - `task_notification` (remove).
  - `background_tasks_changed` (replace the set with its non-ambient entries).
  - Unknown shapes are ignored.

### Success Criteria
- [ ] Parser tests: the observer sees every JSON frame in order, and mapped output is
  unchanged for existing fixtures.
- [ ] Tracker unit tests: started/notification bookends, level replace, ambient
  exclusion, foreground→background via `task_updated`, terminal status removal.

## Phase 2: Turn finality (hold, continue, bounded background wait)

### Changes
**File**: `packages/daemon/src/runtimes/claude-turn-finality.ts`
- `createClaudeTurnFinality(options)` returns `{ observeRaw, wrap(source), verdict() }`:
  - `observeRaw(raw)`: updates background tasks. While a result is held, an
    `assistant`/`user`/`system:init` frame or a new `result` marks the held result
    **intermediate**: clear the timer, add its token/cost fields to a carry
    accumulator, and set `continued` so `wrap` emits the status line once.
  - `wrap(source)`: an async generator over parser events. `complete` is held (with
    carried usage merged) instead of yielded, and a timer is armed:
    - background hold applies (pending set non-empty ∧ no `…report_task_summary`
      tool_use seen in this invocation ∧ `awaitBackground()` true) → cap timer
      (`AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS`, default 1_500_000, clamped to stuck threshold − 3 min). When the pending set
      empties while still held, switch to the grace timer (the notification should
      start a turn).
    - otherwise → grace timer (`AUTOPOD_POST_COMPLETE_GRACE_MS`, default 30 s, the same
      env as today).
    - A fatal error event keeps today's behaviour (arm the grace force-close).
    - Timer expiry force-closes the streams (`end()`, then `destroy()`), as
      `withPostCompleteGrace` does, and records `closedBy`.
    - At source end: if a result is held, yield it (it carries accounting and the
      last result text). Otherwise, if carried usage remains (an intermediate result
      followed by activity and no new result), yield nothing for it. The verdict
      becomes `active` and the exit classification reports it.
  - `verdict()`: `'none' | 'final' | 'background_pending' | 'background_unresumed' | 'active'`,
    plus the pending count and the wait used, for messages.

**File**: `packages/daemon/src/runtimes/claude-runtime.ts`
- Extract a private `runInvocation(handle, ctx)` used by `spawn` and `resume`:
  parser(observe) → finality.wrap → enriched (stderr, session id) →
  `withIdleLivenessProbe` → `withObservedRuntimeExit` (`withPostCompleteGrace` is no
  longer used for Claude).
- `ClaudeRuntime` constructor gets an optional third arg
  `{ awaitBackgroundTasks?: (podId: string) => boolean }`. It defaults to `() => true`.
- `exitEvents(exitCode, lifecycle, verdict)`:
  - `background_pending` / `background_unresumed` → fatal interrupted error (also on
    exit code 0: the agent ended waiting and the CLI never continued).
  - `active` and exit ≠ 0 → fatal "stopped while still working" interrupted error.
  - otherwise, today's logic (`terminated ∧ final` → non-fatal retained; ≠ 0 → fatal exit).
  - Messages name the pod id in `ap rework <podId>`, give task **counts** only (no
    agent-supplied descriptions), and stay well under the 1,200-character failure
    reason bound.

**File**: `packages/daemon/src/index.ts`
- `new ClaudeRuntime(logger, runtimeContainerManager, { awaitBackgroundTasks: (podId) => { const pod = podRepo.getOrThrow…; return pod.status === 'running' && !pod.pendingEscalation; } })`,
  wrapped in a try/catch that returns `false` (today's behaviour) when the pod cannot
  be read.

### Success Criteria
Automated (`npx pnpm --filter @autopod/daemon exec vitest run src/runtimes/…`):
- [ ] **Issue regression (resume):** the resumed session emits init, an empty
  `result`, then (after the grace period would have fired with today's code) init,
  assistant tool_use frames, a final result, then EOF/exit 0. `kill` is not called,
  exactly one `complete` with the final text and summed tokens is yielded, a
  continuation status is yielded, and there is no error.
- [ ] Same on spawn. Activity arriving after grace was due still disarms (fake timers).
- [ ] Background wait: `task_started` (backgrounded) + result "Waiting…" → no kill
  within grace. Then `task_notification` + init + tool_use + `report_task_summary` +
  final result → single final `complete`, no fatal.
- [ ] Cap expiry → streams ended, verified kill, `complete` then fatal interrupted error
  containing `ap rework`.
- [ ] Notification without a new turn within grace → fatal interrupted error
  (`background_unresumed`).
- [ ] Exit 0 right after a background-pending result → fatal interrupted error.
- [ ] `report_task_summary` seen before the result, or `awaitBackgroundTasks` returning
  false → today's behaviour (grace → kill → non-fatal "Completed turn retained").
- [ ] Ambient-only pending tasks → no hold.
- [ ] Existing broad-earthworm tests, abort/suspend tests and
  `ResumeSessionNotFoundError` tests still pass.

## Phase 3: Consumer contract and instructions

### Changes
**File**: `packages/daemon/src/pods/agent-event-consumption.test.ts` (or the closest
existing consumer test harness)
- Fake runtime stream: `complete` then fatal interrupted error → outcome `failed`, pod
  `failed` with a `failureReason` containing `ap rework`, and the callers do not
  invoke `handleCompletion`. The `operator-messages` resume path is covered by an
  existing harness if one is available. No production change is expected here. Any
  gap found becomes an explicit change and is reported.

**File**: `packages/daemon/src/pods/system-instructions-generator.ts`
- For `pod.runtime === 'claude'`, add a short "Background work" rule: do not end
  your turn while commands you started in the background (Bash `run_in_background`,
  Monitor, background agents) are still running. Run required checks in the
  foreground with an adequate timeout, or wait for their completion and then finish
  with `report_task_summary`. The daemon waits only a bounded time, and a turn that
  ends waiting on background work is treated as interrupted, not complete.
- Test: present for Claude, absent for Codex/Pi/Copilot.

**Docs**: `packages/daemon/CLAUDE.md`, Runtimes section: a short paragraph on Claude
turn finality and the `AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS` setting.

### Success Criteria
- [ ] `npx pnpm --filter @autopod/daemon exec vitest run` for the touched test files.
- [ ] `npx pnpm --filter @autopod/daemon build` / typecheck. `npx pnpm lint`
  (Biome) is clean for the touched files.
- [ ] Broader `npx pnpm --filter @autopod/daemon test`, run once in the foreground;
  any unrelated pre-existing failures are reported as such.

## Testing Strategy
- Mock `StreamingExecResult` handles (existing `createMockHandle`) emit NDJSON on
  PassThrough stdout. Short env windows (as in the existing broad-earthworm tests) or
  `vi.useFakeTimers` for the cap.
- No Docker, live daemon or provider calls.
- Manual check (not possible here): a live Claude worker that starts a background
  suite and ends its turn should continue on the notification. That would confirm the
  §5 interpretation. Recorded as deferred.

## Performance / Operational Considerations
- Release of a final `complete` is delayed until EOF or the 30 s grace when the CLI
  does not exit. The total time to completion is unchanged from today (grace was
  already waited). In the normal case where the CLI exits promptly, the only delay is
  until EOF.
- The background wait is capped at 25 min by default, below the 30 min stuck-pod
  watchdog. The idle liveness probe (10 min) keeps checking the container during the
  wait.

## Open Questions
Resolved. See "Approved decisions" at the top.

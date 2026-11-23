# #648 Claude turn end, post-result termination and validation hand-off — Research

Baseline: `620ef0c7f` (origin/main). Branch `local-pod/issues-1122/648`.
Scope: issue #648 (both occurrences) and #663 root cause 2 (same failure mode).
No live daemon, Docker or provider calls were made. Claude CLI evidence comes from
static inspection of the locally installed CLI binary (see §5). It is marked as
unverified where it could not be confirmed against the CLI in worker images.

## 1. How the Claude runtime decides a turn is final

`packages/daemon/src/runtimes/claude-runtime.ts`

- `spawn()` (`:69`) and `resume()` (`:167`) both run `claude -p --output-format
  stream-json --verbose …` through `containerManager.execStreaming()` and build the
  same pipeline (duplicated code):

  ```
  ClaudeStreamParser.parse(stdout)            // NDJSON → AgentEvent
    → enriched generator                        // stderr interleave, session-id capture,
                                                //   lifecycle.sawComplete = true on 'complete' (:125/:235)
    → withIdleLivenessProbe                     // 10 min idle → container probe
    → withPostCompleteGrace                     // one-shot timer after first complete/fatal
    → withObservedRuntimeExit                   // bounded exit wait, then verified tree kill
    → exitEvents(exitCode, lifecycle)           // (:302)
  ```

- **Finality is not modelled.** The parser maps every `{"type":"result"}` line to
  an `AgentCompleteEvent` (`claude-stream-parser.ts:241`). The runtime treats the first
  `complete` as "the turn finished":
  - `withPostCompleteGrace` (`stream-grace.ts:46-98`) arms a **one-shot** timer
    (`AUTOPOD_POST_COMPLETE_GRACE_MS`, default 30 s) on the first `complete` or
    fatal error. The timer is never disarmed or re-armed by later events. When it
    fires, it calls `.end()` on stdout and stderr, so the parser's readline loop
    ends **even if Claude is still writing events**. Any output after that point
    is lost.
  - `withObservedRuntimeExit` (`observed-runtime-exit.ts:33-58`) then waits
    `AUTOPOD_EXIT_CODE_TIMEOUT_MS` (5 s) for the exit code. Because the CLI is still
    alive, it calls `terminate()` = `handle.kill()` (`claude-runtime.ts:286-300`),
    which kills the CLI's whole process tree (verified, ≤30 s), and observes exit 143.
  - `exitEvents()` (`:302-325`): `terminated && sawComplete` yields the **non-fatal**
    `Claude did not exit after its final result (background processes still running)
    … Completed turn retained.` Otherwise it yields a fatal `Claude process exited with
    code N`. `sawComplete` is set on *any* earlier `complete`, so a kill in the middle of
    a later turn is still reported as a retained completed turn.
- This rule was introduced by #577 (`273754f89`, "verify Claude termination when
  background children keep the CLI alive"). That change made termination verified,
  but it deliberately kept "completed" after a forced kill. #577 assumed that a
  result followed by a non-exiting CLI means the turn is done and only orphaned
  children remain. The CLI can instead continue the session (§5).
- The parser drops every `system` subtype except `init` (`claude-stream-parser.ts:197-207`)
  and every unknown top-level type (`:320`). Background-task lifecycle frames
  (`system/task_started`, `task_updated`, `task_notification`,
  `background_tasks_changed`) are therefore invisible to the daemon.

Timing check against the issue logs:
- Occurrence 1: empty result 19:24:09 → kill 19:24:49 = 30 s grace + 5 s exit wait + ~5 s
  verified kill. Claude was emitting tool calls throughout (19:24:14–40); the
  one-shot timer ignored them.
- Occurrence 2: result 20:11:58 → kill 20:13:10 (~72 s). This matches grace, exit wait
  and a slower verified kill while the background suite was running.

## 2. How a resume after a human reply or queued message starts

`packages/daemon/src/pods/operator-messages.ts` (`sendMessage`, ~`:655-790`)

1. `persistCompletionReply` → `transition(pod,'running',{pendingEscalation:null})`,
   `nudgeRepo.queue(podId, queuedReply)`, then "Human reply recorded." (`:676-684`).
2. If the `ask_human` waiter is still attached, resolve it and return. The live run
   continues. If it is detached (the MCP stream timed out), use the
   `buildDetachedMcpFallbackMessage` text and log "MCP response stream was closed —
   queued human reply for check_messages" (`:690-706`).
3. If a run is still active (`queueForRetainedRun`, `:673/:708`), the reply is only
   saved for `check_messages`. No resume starts.
4. Otherwise: "Resuming agent with message…" (`:728`) → `prepareRetainedAgentContinuation`
   → `runtime.resume(podId, continuationMessage, containerId, env)` (`:744`) →
   `this.consumeAgentEvents(...)` → if `outcome === 'completed'`, then
   `this.handleCompletion(podId)` (`:782-784`).

`ClaudeRuntime.resume()` starts a **new CLI process** with `--resume <session>`
plus the prompt. It goes through the same pipeline as §1, so its first `result`
(empty or intermediate) arms the one-shot grace.

## 3. How the end of a turn flows into validation

- `consumeAgentEvents` (`pods/agent-event-consumption.ts`) **does not stop at a
  `complete`**. It keeps reading. Each `complete` sets `outcome = 'completed'`
  (`:620-623`), runs `fileObserver.finish()` (`:427-433`), adds token/cost deltas
  (`:532-603`), calls `completionJournal.settle(pod, event.result)` (`:606-612`),
  checks blocker wording (`:627-640`) and enforces the budget. A non-fatal error does
  not change `outcome`. A fatal error (`:756-830`) moves the pod to `failed`, sets
  `outcome = 'failed'` and breaks.
- The non-fatal "Completed turn retained" error therefore leaves `outcome = 'completed'`.
  Callers then run `handleCompletion`:
  `agent-process-workflow.ts:737-739` (initial run), `operator-messages.ts:782-784`
  (human-reply resume), and the correction/guidance paths in `operator-messages.ts:635`.
  A `failed` outcome instead calls `preserveSandboxAfterAgentFailure` and
  `releaseZeroWorkFailure` (`agent-process-workflow.ts:740-743`). There is no validation.
- `handleCompletion` (`pods/completion-workflow.ts:99-170`): goal/findings guards,
  status bail-outs, `holdCompletionForHumanWork` (`completion-human-gate.ts:136-157`):
  a pending escalation produces "Agent settled; human decision remains unanswered",
  and a pending nudge produces "Worker settled with uncollected human guidance"
  (failed). Then `prepareSourceForCompletion` → `applyCompletionDecision` →
  `triggerValidation` → "Starting custom validation (attempt n/N)…".
- The review-source failure in occurrence 1 comes from
  `validation-review-source.ts:185-195` ("Review source could not be read
  consistently …"). This happens downstream of validating a half-edited
  workspace: the symptom, not the cause. Once the interrupted turn no longer reaches
  `handleCompletion`, this message no longer stands in for "agent interrupted".
- A fatal error is persisted as a terminal agent event, so after a restart
  `hasLatestPersistedAgentTerminalEventComplete` (`agent-execution-policy.ts:21-40`)
  sees `error` as the latest terminal event and will not skip straight to completion.
- `ap rework` accepts `failed` pods and keeps the worktree when agent work exists
  (`validation-trigger-workflow.ts:330-345`). A failed pod with a clear reason is
  therefore directly recoverable.

## 4. Other bounds that interact with a longer wait

- `withIdleLivenessProbe` (`stream-grace.ts`, default 10 min) probes the container when
  there are no events and continues while it is alive. A quiet background wait is safe.
- Stuck-pod watchdog (`workspace-watchdog.ts:28-36`): a `running` pod with no agent
  event or heartbeat for `AUTOPOD_STUCK_RUNNING_THRESHOLD_MS` (default **30 min**) is
  auto-failed. Any background wait must stay well below 30 min.
- While a run is active, a human reply is only queued (§2 step 3). Holding the
  process open while a pod waits for a human would stop that reply from resuming
  the agent. Do not hold while a human decision is pending.

## 5. What the Claude CLI emits (static evidence)

Worker images install an **unpinned** `@anthropic-ai/claude-code`
(`templates/base/Dockerfile.node22:54` and siblings), so the exact CLI version in a
given worker is unknown. The repo has no vendored Claude CLI docs or stream
fixtures (`runtimes/fixtures/` only has a Codex fixture). Evidence below comes from
`strings` over the local CLI binary **2.1.318**: SDK zod schemas and `.describe()`
text embedded in the bundle. It has **not** been confirmed with a live run.

Verified present in the 2.1.318 schemas:
- `{"type":"system","subtype":"task_started", task_id, tool_use_id?, description,
  task_type?, is_backgrounded?, ambient?, skip_transcript?, …}`. `is_backgrounded` is
  "set for local_agent and local_bash tasks".
- `{"type":"system","subtype":"task_updated", task_id, patch:{status?
  ('pending'|'running'|'completed'|'failed'|'killed'|'paused'), is_backgrounded?, …}}`.
  A foreground Bash command that reaches its timeout "moves to the background",
  which arrives as `patch.is_backgrounded`.
- `{"type":"system","subtype":"task_notification", task_id, tool_use_id?, status:
  'completed'|'failed'|'stopped', reason?: 'worker_restart', output_file, summary}`.
- `{"type":"system","subtype":"background_tasks_changed", tasks:[{task_id, task_type,
  description, ambient?, …}]}`. It is described as "The full set of live background
  tasks … REPLACE semantics … level signal … consumers must reset to the empty set
  whenever the session's CLI process (re)starts" and "nothing is emitted at startup".
- `ambient: true` marks "tasks that are not activity (every skip_transcript task,
  plus every live-update watcher …); hosts should exclude them from activity
  indicators".
- The result schema includes `result_index` ("Delivery sequence of this result
  within the run … A result held back while background work finishes is numbered
  when it is finally written") and `queued_turn_count` ("Greater than 0 means at
  least one more user turn (and result) follows"). **One `-p` process can write
  several results.**
- `total_cost_usd`: "Cumulative … across turns … each result carries the running
  total so far, so read the latest result rather than summing across results". On a
  resume it "continues from the total its transcript saved". The daemon sums the
  cost of each `complete`, so several results per process (and resumes) inflate
  `costUsd`. This is a **pre-existing** issue and outside #648; see Open questions.
- A headless queue phase `background_wait (waiting on background tasks before
  looking at the queue again)`. The `[print.ts]` resume code includes
  `orphaned_background_tasks_pending_notification`, `[orphanRestoreWake] Waking the
  session for background tasks or timers lost to the restart` and "Auto-resuming
  interrupted turn".
- `system/session_state_changed {state:'idle'|'running'|'requires_action'}` is described
  as "'idle' fires after heldBackResult flushes … authoritative turn-over signal".
  It is emitted **only** when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set.
  Autopod does not set it.

Interpretation (consistent with the logs and the strings, but **unverified live**):
- **Background tasks pending at turn end:** in `-p` mode the CLI writes the
  turn's `result` and stays alive in `background_wait`. When a task finishes it
  enqueues a `task_notification` and runs another turn in the same process, which
  shows up as `system/init` and then assistant/user frames, and ends in another
  `result`. Occurrence 1 shows this shape: an empty result, then
  `Claude pod initialized (<same session>)` 5 s later, then real tool calls.
- **Resume with leftover background work:** the killed (143) previous process left
  orphaned tasks or timers. The resumed process wakes the session for them first,
  which plausibly produces the empty result, and then processes the human prompt. The
  exact cause of the empty result **cannot be confirmed** without a live trace.
  The fix must not depend on it.
- Older CLI versions may not emit task lifecycle frames. In that case the daemon
  cannot know whether background work is pending, and must fall back to activity
  only (§ plan).

## 6. Root cause summary

1. The one-shot post-complete grace ignores activity after a result, so the daemon
   force-closes and kills a session that is still producing a turn (occurrence 1).
2. The daemon has no notion of pending background tasks. A result that says
   "waiting for X" is treated as final, and the session is killed after about 35 s
   instead of being allowed to continue on the notification (occurrence 2, #663 RC2).
3. After a forced kill, `exitEvents` reports a retained completion whenever *any*
   `complete` was seen. The consumer therefore stays `completed` and the callers
   start validation on an unfinished, possibly mid-edit workspace.
4. Defence in depth is missing: worker instructions do not tell Claude to avoid
   ending a turn with background work pending.

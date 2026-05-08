# ADR-021: Sleep-recovery via reconcile-on-wake

## Status

Accepted

## Context

The autopod daemon runs on a developer's macOS laptop. When the laptop
sleeps for more than a few minutes:

- TCP / SSE connections to LLM APIs (Anthropic, OpenAI, GitHub Copilot)
  die. Anthropic's server-side request timeout is in the order of
  minutes, not hours.
- Docker Desktop pauses the agent containers — their CPU is suspended,
  any in-flight tool calls cannot complete.
- The daemon process itself is suspended by the OS; `Date.now()` keeps
  ticking on the wall but `setInterval` callbacks do not fire during
  sleep.

On wake, the daemon's existing time-based watchdogs see what looks like
a long silence:

- `startStuckPodWatchdog` (`pod-manager.ts:8273`) fails any `running`
  pod whose `lastAgentEventAt` exceeds `AUTOPOD_STUCK_RUNNING_THRESHOLD_MS`
  (default 30 min).
- `withIdleLivenessProbe` (`stream-grace.ts:255`) probes the container
  after 10 min of stream silence; on a paused container the probe
  fails and emits a synthetic fatal-error event.
- Validation timeouts in `local-validation-engine.ts` use `Date.now()`
  deltas that are blind to the gap.

Net effect: pods that were running before sleep are auto-failed on wake.
A user who closes their laptop overnight loses every running pod.

Three approaches were considered.

### Option A — Forgive timestamps

A sleep detector observes that wall-clock advanced far more than the
tick interval, declares "host slept for D ms", and bumps every
watchdog's reference timestamp forward by D. The daemon pretends no
time passed. The dead TCP connections are not magically alive; the
existing retry budgets in `withEngineStallRetry` and the idle probe
re-arm logic are expected to cope.

### Option B — Reconcile on wake

Treat wake as a wake-class equivalent of daemon-restart-orphan
recovery. On detection, call the existing
`reconcileLocalSessions()` (`local-reconciler.ts:33`) with a `'wake'`
trigger. Pods get re-queued with `recoveryWorktreePath`; old containers
are killed; new containers spawn; existing worktrees are bind-mounted;
Claude pods resume via `--resume <claude_session_id>`. Codex/Copilot
respawn with the original task plus a wake-correction postscript.

### Option C — Explicit `paused` state with reconcile-on-resume

Detect wake; transition all eligible pods through a new sleep-paused
state; explicitly tear down dead streams; on resume run the same
recovery as B. Architecturally cleanest, but mirrors ADR-006's
`runner_offline` state which was never built — the architectural-cost
vs. user-value ratio is unfavourable for a single-process scenario.

## Decision

**Option B: reconcile on wake, reusing the existing
`reconcileLocalSessions()` path.**

Detection has two layers:

1. **Tick-gap heuristic (primary, cross-platform).** A `setInterval`
   every 30 s records `lastTickAt`. When the next tick fires, a gap
   exceeding `AUTOPOD_SLEEP_DETECT_THRESHOLD_MS` (default 180 s)
   publishes a `host.resumed` event.
2. **macOS power-notification adjunct (precision aid).** When
   `process.platform === 'darwin'`, optionally subscribe to a native
   power-event source (e.g. `node-mac-power-monitor` or `pmset -g log`
   tail). Deduped against the tick-gap event within a 5 s window.

Wake-recoveries are exempt from two existing cap counters that were
designed for *true* failure scenarios (a wedged pod that crashes the
daemon every time):

- `MAX_RECOVERIES = 3` in `local-reconciler.ts:213` is **not**
  enforced when `trigger === 'wake'`. `recoveryCount` is **not**
  incremented.
- `validationAttempts` is **not** incremented for the *first* validation
  entry of a wake-recovered pod.

Both exemptions are gated by a new `pods.last_recovery_trigger` column
(`'wake' | 'restart' | null`), set by the reconciler and consumed
(then cleared) by `processPod()`'s validation entry point. The flag is
one-shot.

For non-Claude runtimes (Codex, Copilot — which lack session-resume
primitives), the resumed task prompt is augmented with a
wake-correction postscript pointing the agent at `git log` /
`git diff main` so it can identify already-committed work.

Time-based watchdogs (`startStuckPodWatchdog`, `withIdleLivenessProbe`)
subscribe to `host.resumed` and suppress failure paths for a 60 s grace
window so the reconciler has time to land its state transitions.

A `host.resumed` event is published on the WebSocket. The macOS
desktop app surfaces a transient banner:
`Resumed after Xm — N pods OK`.

## Consequences

**Easier**

- Reuses the existing reconciler and `recoveryWorktreePath` recovery
  branch in `processPod()` — no duplicated provisioning logic.
- Aligns with the project's existing taste (ADR-007: re-queue over
  in-place resume; ADR-008: kill old container, spawn fresh).
- Cross-platform tick-gap detection works on any host the daemon runs
  on; macOS adjunct is precision-only and degradable.
- Cap exemption is gated by a single one-shot pod-row flag — the
  blast radius of getting the exemption logic wrong is bounded to a
  single recovery cycle.

**Harder**

- Adds a new column to the `pods` table (`last_recovery_trigger`).
  Reversible by reverting migration 092.
- A second `host.resumed` publication is needed (initial from detector
  with empty `reconciledPodIds`, completed from pod-manager with the
  populated list). Subtle but documented; the desktop banner buffers
  the first event briefly.
- Codex / Copilot pods lose conversation context across wake — their
  runtimes don't expose session resume. The textual postscript is a
  mitigation, not a fix; the agent may redo work in some cases.
- An in-flight `processPod()` loop may exist for a `running` pod when
  wake fires. The reconciler synchronously transitions the pod to
  `queued` first; in-flight loops detect the change at their next
  state-check point and exit. If any await point lacks a state-check,
  brief 02 introduces per-pod `AbortController` infrastructure.

**Committed to**

- `host.resumed` event in `SystemEvent` union — once consumed by the
  desktop banner, removing or renaming requires a coordinated
  client/server change.
- `pods.last_recovery_trigger` column — the cap-exemption mechanism
  hinges on it.
- The 30 s sleep-detector tick interval being faster than the 60 s
  watchdog tick. If either constant is changed, the wake-grace window
  must remain larger than the watchdog interval.

## Alternatives rejected

- **Option A (Forgive timestamps).** Bumping watchdog references
  forward doesn't address the dead-socket reality. The daemon would
  pretend everything is fine, but the LLM stream is gone. Existing
  retry budgets weren't designed for 4-hour gaps; pods would limp,
  fail in confusing ways, or sit indefinitely. Worse user experience
  than reconcile.
- **Option C (Explicit `paused` state).** Adds a new state, new
  transitions, new UI handling, new persistence — all to model
  something that doesn't actually need to be modelled when the
  reconciler-on-restart pattern already does the right thing.
  ADR-006's `runner_offline` state was never built; following its
  shape for a single-process scenario would be over-engineering.
- **SIGSTOP / SIGCONT-style explicit pause-resume.** Predicated on
  detecting *imminent* sleep, which macOS does not reliably notify
  in-process before suspension. Same fairy-tale-engineering objection
  as ADR-006.

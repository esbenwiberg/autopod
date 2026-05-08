# Sleep resilience

## Problem

When the host laptop sleeps for more than a few minutes, running pods get
killed by time-based watchdogs (stuck-pod watchdog at 30 min default,
idle liveness probe at 10 min, validation timeouts) the moment the daemon
resumes. The underlying TCP/SSE connections to LLM APIs die during sleep,
and Docker containers are paused — neither survives a long sleep. Users
who run pods overnight or during long meetings lose work to false-fail
detection on wake.

## Outcome

After a host sleep that exceeds the detection threshold, every pod that
was active before sleep automatically reconciles via the existing recovery
path within ~60 s of wake. No false fails, no manual retry.

## Users

The autopod daemon operator running on a macOS laptop. Affects pods with
`executionTarget === 'local'`. ACI / cloud pods are unaffected (their
hosts don't share the laptop's sleep cycle).

## Success signal

On host wake after a sleep > threshold:

- Pods that were in `running`, `provisioning`, `awaiting_input`,
  `validating`, or `paused` before sleep transition through
  `queued → provisioning → running` within ~60 s of wake.
- No pod is force-failed by the stuck-pod watchdog due to the sleep gap.
- Desktop shows a brief banner: `Resumed after Xm — N pods OK`.

The wake-recovery path goes through the same reconciler as daemon-restart
recovery (`reconcileLocalSessions()` in
`packages/daemon/src/pods/local-reconciler.ts:33`), so a pod's worktree,
PR state, validation history, and Claude session ID are all preserved.

## Non-goals

- Cross-sleep context preservation for Codex / Copilot agents beyond a
  textual postscript. Those runtimes don't expose a session-resume
  primitive; the agent re-spawns with the original task plus a "you
  were interrupted, check `git log`" hint.
- Cloud / ACI pods. They run in Azure and aren't affected by the
  laptop's sleep cycle. The reconciler already filters to
  `executionTarget === 'local'`.
- Force-committing dirty workspace state on wake. Auto-commits would
  corrupt the agent's intended commit history; not worth the scope.
- Sleep detection on Linux or Windows daemons via OS-level power events.
  Tick-gap detection works cross-platform; macOS power-notification
  precision is the only platform-specific addition.
- Deleting or replacing the existing daemon-restart reconciler. The wake
  path reuses it with a different trigger.

## Glossary

- **Wake**: the moment after host sleep when the daemon's event loop
  resumes ticking on the host. Detection is always post-hoc — the
  daemon process was suspended during sleep, so it learns about the
  sleep only after it ends.
- **Wake-recovery / wake-reconcile**: invoking
  `reconcileLocalSessions()` with `trigger: 'wake'` to bring local pods
  back through `queued → provisioning → running` with their existing
  worktree and (for Claude) session ID intact.
- **Threshold**: the wall-clock gap that distinguishes "host slept"
  from "GC pause / event-loop blip". Default 180 000 ms. Configurable
  via `AUTOPOD_SLEEP_DETECT_THRESHOLD_MS`.
- **Tick-gap heuristic**: a `setInterval` recording `lastTickAt`. When
  the tick fires, `Date.now() - lastTickAt` far exceeding the interval
  indicates process suspension. Cross-platform; the primary detector.
- **Wake grace window**: a 60 s period after a `host.resumed` event
  during which the stuck-pod watchdog and idle liveness probe suppress
  their failure paths so the reconciler has time to land.
- **`lastRecoveryTrigger`**: a one-shot column on the `pods` row set
  by the reconciler to `'wake'` or `'restart'` and consumed (then
  cleared) by `processPod()` to decide whether to charge the recovery
  against `MAX_RECOVERIES` and `validationAttempts`.

## Reversibility

Adds one nullable column (`last_recovery_trigger TEXT`) to the `pods`
table. Roll-back: revert migration 092 (drop column). The column is
transient — cleared after the first validation entry post-recovery —
so no data is lost beyond that single transient flag. The sleep-detector
module can be disabled at runtime via `AUTOPOD_DISABLE_SLEEP_DETECT=1`
without removing code, allowing fast rollback if false positives
appear in production.

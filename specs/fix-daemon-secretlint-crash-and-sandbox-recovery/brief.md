---
title: "Prevent Secretlint daemon crashes and recover interrupted Sandbox pods safely"
touches:
  - packages/daemon/src/index.ts
  - packages/daemon/src/performance-cleanup.ts
  - packages/daemon/src/performance-cleanup.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/agent-shim.test.ts
  - packages/daemon/src/pods/reconciler.ts
  - packages/daemon/src/pods/reconciler.test.ts
does_not_touch:
  - packages/shared/
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/daemon/package.json
  - pnpm-lock.yaml
  - packages/cli/
  - packages/desktop/
  - scripts/deploy-hosted-daemon.sh
---

## Task

Prevent the hosted daemon from crashing when periodic performance cleanup overlaps a Secretlint
scan, then close the three Sandbox restart-recovery gaps exposed by the same incident: unwritable
agent PID state, ignored interrupted provisioning, and provider-attempt identity mismatch after a
fresh recovered runtime session. Keep the change inside `@autopod/daemon` and preserve existing
append-only accounting, secret permissions, validation-only recovery, and durable-session resume
semantics.

## Why

On 2026-08-13 the hosted VM remained running, but `autopod-daemon.service` exited and systemd
restarted it six seconds later. The process died with:

```text
DOMException [SyntaxError]: The
"@core>setup-rule::end||@secretlint/secretlint-rule-preset-recommend"
performance mark has not been set
    at node:internal/perf/usertiming:65
    at @secretlint/profiler/module/index.js:26:43
```

The restart interrupted four unrelated pods. Their host worktrees survived, but recovery left one
pod inert in `provisioning`, failed to record a Sandbox worker PID, and rejected a recovered Codex
session with `provider attempts are append/close-only`. Recovery required operator intervention
and additional provider runs despite preserved checkpoints.

The crash is deterministically reproducible by starting a real Secretlint `lintSource()` call,
clearing global performance marks/measures before its deferred profiler measurement, and awaiting
the next event-loop turn. The same scan completes when marks are not globally cleared.

## Touches

- `packages/daemon/src/index.ts`
- `packages/daemon/src/performance-cleanup.ts`
- `packages/daemon/src/performance-cleanup.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`
- `packages/daemon/src/pods/agent-shim.test.ts`
- `packages/daemon/src/pods/reconciler.ts`
- `packages/daemon/src/pods/reconciler.test.ts`

## Does not touch

- `packages/shared/`
- `packages/daemon/src/db/migrations/`
- `packages/daemon/src/pods/local-reconciler.ts`
- `packages/daemon/package.json`
- `pnpm-lock.yaml`
- `packages/cli/`
- `packages/desktop/`
- `scripts/deploy-hosted-daemon.sh`

## Constraints

- `packages/daemon/src/index.ts:185-194` claims to clean unused fetch Resource Timing data but
  currently calls process-global `performance.clearMarks()` and `performance.clearMeasures()`.
  Extract a small testable cleanup helper and clear only Resource Timing entries. Do not delete
  User Timing marks or measures owned by Secretlint or any other dependency.
- Keep the existing timer lifecycle: it remains unreferenced during normal operation and is
  cleared during graceful shutdown. Do not introduce a second timer.
- Exercise a real Secretlint scan in the regression fact. Its profiler defers measurement, so a
  test that only awaits the direct `lintSource()` promise may miss an uncaught observer/microtask
  failure. Use a separate process or another deterministic harness that proves process survival
  and the absence of the missing-mark exception.
- Do not upgrade, patch, or fork Secretlint as the fix. Current and later profiler implementations
  still use named global performance marks; Autopod must stop deleting marks it does not own.
- `packages/daemon/src/pods/pod-manager.ts:657-667` writes
  `/run/autopod/agent.pid` from the non-root agent shim. Sandbox file uploads and the surrounding
  directory are root-owned. Provision only the PID file with ownership/mode that lets the
  container user replace its contents. Do not make `/run/autopod`, credential files, or the env
  shim broadly writable.
- Treat failure to arm PID-based restart recovery as explicit provisioning/runtime evidence. Do
  not retain the current silent `|| true` behavior if it would let Autopod claim quiescence is
  available when it is not.
- `packages/daemon/src/pods/reconciler.ts:23-32` currently selects only `running`,
  `awaiting_input`, and `paused` Sandbox pods that already have a container ID. Include an
  interrupted `provisioning` row even when `containerId` is null. Rebuild its lost in-memory queue
  membership through a bounded, idempotent recovery path.
- Use the existing local reconciler only as behavioral reference; do not refactor it. Preserve a
  viable host worktree/checkpoint, clear incomplete container binding, update lifecycle/recovery
  accounting, and enqueue exactly once. If neither a worktree nor safe fresh provisioning is
  possible, park/fail with an operator-visible reason instead of leaving a non-terminal inert row
  or starting a paid agent blindly.
- Preserve validation-only recovery. An interrupted pod whose agent already completed or whose
  `skipAgent` flag is set must not be sent through another agent run.
- Provider attempt rows are deliberately append/close-only. Do not weaken or replace the database
  triggers in migrations 127/130. At the first recovered runtime event carrying a session ID,
  compare it with the active attempt: keep a true same-session continuation on that attempt, but
  close the old attempt as `aborted` and append a new attempt before recording a different native
  identity or any new token/cost data.
- Ensure a new attempt is closed correctly if the recovered runtime fails after rotation. Do not
  manufacture an empty attempt for a genuine same-session resume or an unstarted failover
  continuation.
- Keep recovery idempotent across repeated daemon restarts and prevent duplicate agent execution
  or double enqueue.
- Do not add a `PodStatus`, shared wire contract, schema migration, new dependency, desktop/CLI
  surface, or hosted deployment behavior.

## Skills to reference

- None. This change does not add a profile field or lifecycle status and therefore does not use
  `/add-profile-field` or `/add-pod-state`.

## Test expectations

- Add `packages/daemon/src/performance-cleanup.test.ts` with a deterministic real-Secretlint
  regression proving cleanup leaves third-party User Timing entries intact and clears Resource
  Timing entries without process termination.
- Extend `packages/daemon/src/pods/pod-manager.test.ts` to prove Sandbox provisioning creates a
  narrowly writable PID file while keeping secrets/runtime directories protected.
- Extend `packages/daemon/src/pods/agent-shim.test.ts` with runtime-user behavior proving the shim
  records the PID before `exec`, and makes PID-write failure observable.
- Extend `packages/daemon/src/pods/reconciler.test.ts` for recoverable and unrecoverable
  `provisioning` rows with null container IDs, preservation of worktree and `skipAgent` semantics,
  bounded accounting, exactly-once enqueue, and repeated-reconcile idempotence.
- Extend `packages/daemon/src/pods/pod-manager.test.ts` to cover both branches of post-restart
  session identity: a different emitted identity rotates before ledger updates and completes
  without the database trigger error; the same identity continues without a duplicate attempt.
- Run the five required-fact commands in `contract.yaml` during iteration, then run the repository
  validation pipeline from `AGENTS.md`: `./scripts/validate.sh`.

## Risks / pitfalls

- A naive in-process Secretlint test may appear green while an uncaught profiler callback later
  crashes Vitest. The regression must wait through the deferred measurement or isolate the child
  process and assert its exit code/output.
- Requeueing `provisioning` indiscriminately can duplicate work or bypass dependency/series gates.
  Reuse the queue's deduplication and existing recovery bookkeeping; do not blindly update every
  provisioning row to queued.
- The Sandbox file API's root ownership is intentional for credential material. Narrowly adjust
  only the PID control file.
- Runtime adapters can emit session status more than once. Rotation must occur at most once for a
  new identity and before the immutable attempt is updated.
- A provider attempt may already contain token and cost data. Closing it must preserve those exact
  values; new accounting belongs only to the appended attempt.

## Wrap-up

Before finishing:

1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.

---
date: 2026-10-17
researcher: Codex
git_commit: 5385bfd6f37e17c8e8ef03ae49b2f7a6f990e142
branch: codex/pod-manager-workspace
repository: autopod
topic: Starting an ordinary triggerValidation attempt
status: complete
---

# Research: validation attempt start

## Question and baseline

What is the first bounded validation-orchestration region after completing slice 6?
All source references below are relative to packages/daemon/src/ at 5385bfd6.
The managed worktree was clean. pod-manager.ts is 17,736 lines.

## Current structure

triggerValidation (:13361) first checks task execution/deletion ownership and native
Goal achievement/termination. It can begin manual Goal/task Rework, captures lifecycle
identity, creates update-from-base closures, rejects compromised worktrees and resolves
the effective bound profile. A forced-terminal branch (:13424–13558) can preserve old
source, fence the generation, tear down resources and requeue for fresh provisioning.
It returns before the ordinary validation attempt begins.

The next contiguous region (:13560–13597) starts an ordinary attempt:

1. assertGuidanceCollected(podId) rejects queued/uncollected nudges. It does not
   implement a general pending-question gate (:2312).
2. Await runPushCheckpointScan(pod, profile). This unchanged shared helper (:3638)
   no-ops without a scanner/worktree, derives origin/base, runs the push scan, throws
   AutopodError for a block, warns for escalate and logs/continues for ordinary scanner
   errors. AutopodError propagation and ordinary-error fail-open behavior are distinct.
3. If fromTerminal, reset stored validationAttempts to zero before the transition.
4. transition(pod, validating) returns s1. The manager's shared transition (:6409)
   validates, writes status, marks completion-journal state, publishes status after
   commit and reloads the pod. Keep that helper and its other callers unchanged.
5. If s1.lastRecoveryTrigger is wake, retain s1.validationAttempts and clear the wake
   flag. Otherwise use (fromTerminal ? 0 : s1.validationAttempts) + 1 and persist it.
   Terminal reset occurs before the wake check: terminal+wake can therefore start at
   zero. restart is not treated as wake. A non-wake recovery marker is not cleared here.
6. Emit pod.validation_started with the selected attempt and a new timestamp.
7. Resolve the suite from s1, build an optional rework label and emit the exact
   Starting ... validation activity. s1 is the transition result before the subsequent
   counter/wake update; there is no final reload in this region.

The following try (:13599) checks container availability, starts/probes the container,
prepares the workspace, constructs validation configuration and executes the engine.
It also owns retries, result processing and cancellation. attempt and validationSuite
feed engine configuration and later messages; s1 is used for validation phase skips.
The attempt-start region is outside that try. A rejected guard, scan, update, transition,
start-event publication or activity is not newly caught by that later handler.

## Other paths and shared code

revalidateSession (:14757) has a distinct start sequence at :14837 onward. It resets
attempts before its push scan, can requeue a missing container, always selects attempt
one and emits different activity. It does not share the triggerValidation wake policy.
Workspace/interactive completion and force-Rework also have distinct paths.

getPodValidationSuite (:1848) returns an explicit suite first, then off for
options.validate === false, otherwise full. Suites are off, thin, thin-with-facts,
deterministic, full and custom. Starting an explicit triggerValidation operation does
not itself bypass validation simply because the suite is off; completion's decision
module owns its separate bypass rules.

The event bus persists before broadcast and catches subscriber exceptions
(pods/event-bus.ts). A subscriber error therefore differs from persistence/emit failure.
Attempt updates and events are separate effects; no atomic rollback is established.
The captured pod/profile/fromTerminal values precede the awaited scan, and there is
no new lifecycle ownership recheck in this start region.

## Existing evidence

pod-manager.test.ts:24436–24526 covers wake hold/clear, normal increments and restart.
:18800 onward covers terminal resets, forced Rework reprovisioning and push-scan
remediation. Operator-guidance and pod-bridge validation suites cover their own
delivery/admission connections. State-machine and unit-of-work suites cover shared
transition/commit behavior. Security scan suites own scanner/policy internals.

Slice 6 passed 129 selected public compatibility cases, 29 direct SQLite cases and
1,318 affected tests. Its qualified full run passed 7,473 Vitest plus 35 Node tests,
with 10 existing gated skips. That final run used process-local maintenance.auto=false
after default runs reproduced a disappearing Git maintenance lock in unchanged
managed source-delivery scanning. No global Git setting or product fix was applied.
These are predecessor results, not slice 7 execution evidence.

No product or test code changed and no tests ran during this research. The companion
plan fixes a small attempt-start extraction. There are no unresolved questions.

---
date: 2026-10-19T00:01:04+02:00
researcher: Codex
git_commit: 38d70d53bf437e7920e92569a39143ddeae21c13
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 24: remaining agent dispatch, event consumption and run ownership"
tags: [research, codebase, pod-manager, agent-execution]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice 24 research: agent execution and event accounting

## Research question and source

Under the authorized remaining-slices roadmap, where do agent dispatch, stream
consumption, active-run ownership and terminal accounting currently live, and what
must their compatibility boundary retain? This documents current source. The next
plan owns implementation choices. The Slice 23 implementation baseline is pushed;
its full frozen qualification subsequently passed (see the Slice23 plan/proof).

All source references below use packages/daemon/src/pods/pod-manager.ts at the
commit above, unless another path is named. The manager is 10,296 lines. Slice 23
has extracted the complete provisioning workflow and returns PreparedExecution or
halted. Source/AST metadata is saved in .autopod-data/agent-execution/; no Slice 24
product code is changed during research.

## Current dispatch and outer lifetime

processPod (:5046–5798, 753 lines) still owns its original queued/handoff guard,
lifecycle generation, derived starting attempt, visible failure phase, observed-event
flag, staged reference archive set and startup admission. finishStartup closes the
same admission object that provisioning can assign through its accessor port.
The provisioning call and prepared-context destructure (:5094–5135) feed the remaining
execution branch; an interactive or parked preparation returns through the original
finally without dispatch.

The dispatch branches (:5135–5554) inspect execution provenance before skip-agent,
recovered-complete or runtime execution. Skip-agent clears its one-shot flag before
validation-only recovery or completion. Recovery can bypass the agent when persisted
terminal evidence, or a native Goal achievement with confirmed termination, permits
completion. Runtime construction includes provider-attempt rotation, normal spawn,
rework, Claude/Codex/Pi resume and fresh recovery. The Claude resume fallback generator
captures the active run token before awaiting resume, fences before replacing native
session identity, records continuation provenance and fences again before fresh spawn.
Native Goal execution is an async generator whose work begins during event consumption,
after durable taskRunId ownership exists; ownership checks fence state callbacks.

The event observation wrapper (:5557–5566) finishes startup on the first actual event
and clears infrastructureFailure before yielding it. consumeAgentEvents is called
with generation, container and native-Goal flag. Afterwards lifecycle ownership gates
credential persistence and completion or sandbox preservation.

The original catch/finally (:5595–5797) shares local state with provisioning/dispatch.
It settles startup, ignores superseded ownership, routes transient sandbox/host-fetch
failures, persists host credential escalation, formats operator failure, preserves
runtime credentials and parks failed provider continuations. Its bounded container
kill clears its timeout and only releases the recorded container on confirmed kill.
The final fallback records failed or killed status where allowed. finally always
settles unknown startup and removes every staged reference archive. No part of this
catch/finally has moved during Slice 23.

The method calls exactly three dynamic receiver members: triggerValidation,
handleCompletion and consumeAgentEvents. These resolve on the invocation receiver.
Its live dependency reads are launchConfiguration, eventRepo and providerAttemptRepo.
Other dependencies are captured closure references, including provisioningWorkflow,
provider-attempt/context functions, resource cleanup and failure/recovery callbacks.

## Current stream consumption and durable boundaries

consumeAgentEvents (:5800–6444, 645 lines) has no this calls. It rejects non-native
Goal continuation and checks lifecycle, container, runtime/model/provider binding,
execution target and worktree before admitting a stream. It creates a unique run
symbol and settlement promise. ownsRun also checks the current provider ordinal.

Initialization atomically begins the completion cycle, registers/begins task execution,
admits worker retry with immutable binding/backoff, ensures the provider attempt,
loads persisted completion keys and then publishes the active-run/resolver entries.
Commit polling starts only after initialization. Initialization failure settles any
durable task/retry records and clears only the same run token.

The loop checks retry cooldown, ownership and pause intent before accepting events.
Accepted events publish activity and bump throttled liveness. Escalation, plan,
progress, task summary and native session events update their existing repositories.
A changed reported native session rotates rather than rewrites provider history.
Completion replay checks both a hashed event key and already-counted telemetry before
publication/accounting. Completion records journal settlement, cumulative and per-phase
usage/cache/cost, provider attempt telemetry and accuracy, then applies blocker and
budget rules. Native Goal achievement has its existing budget exception. Fatal or
unverified-termination events preserve classification and failure/limit state;
tool/file changes touch heartbeat.

Finalization retains unverified durable execution instead of releasing its admission.
Accepted terminal evidence remains historical if a later callback loses ownership.
Sandbox runtime state sync precedes provider-attempt closure/limit handling. Nested
finally blocks settle durable task/worker records, stop commit polling and clear the
activity throttle only for the matching active token, then resolve/clear the same run.
A superseded consumer returns stopped; a retained error is rethrown with original
identity after cleanup. Live reads include launchConfiguration, providerAttemptRepo,
eventRepo, workerInfrastructureRetryBackoffMs and workerInfrastructureRetryDelay.

## Shared state and helpers

The original activeAgentRuns (:2270–2279) and activeAgentRunResolvers (:2280) maps
are created before provider-attempt context composition. The provider-attempt owner,
continuation controls, process/consumer and public pause/kill paths use the same
active-run map. The entry stores token, settled promise, optional provider ordinal,
optional taskRunId and ownership callback. The resolver entry stores token/resolve.
Resolver entries are private to consumer settlement.

lastEventWriteAt (:2384) and EVENT_TIMESTAMP_WRITE_THROTTLE_MS (:2385, 10 seconds)
feed bumpActivityTimestamp (:2393–2403). Both stream events and the still-inline
emitActivityStatus/Error helpers call the same throttle. Stream finalization removes
its pod entry after the matching run ends. touchHeartbeat (:3411–3417) performs a
best-effort direct timestamp update; it is also exposed as a public function reference.
recordNotReportedMemoryUsage (:4239–4241) reads deps.memoryUsageRepo at invocation
and is called by the shared transition helper (:4197).

The six complete static accounting helpers (:1089–1173) derive phase attempt/index,
recognize latest persisted complete versus fatal error after a watermark, hash the
original completion fields, gather persisted completion keys and check prior counted
usage/cost. AgentRunOutcome is the exported union at :787; public callers continue
importing it from pod-manager. Roadmap ownership assigns these, the four state
bindings, the three small closure helpers, consumeAgentEvents/public heartbeat and
the remaining process lifetime to milestone 24. Activity emission/transition policy
and resource polling algorithms are separately assigned to later milestones.

## Existing evidence and repository patterns

The unchanged public manager suite has 1,192 cases and remains byte-frozen under
Slice 23. It exercises dispatch/recovery, stale generation, native sessions, repeated
completion/telemetry, provider limits, retry admission, pause/kill and settlement.
Concrete examples include retained unverified termination and blocked replay
(:3337–3447) and a superseded lifecycle that consumes no events/begins no task run
(:4001–4029). Actual migrated SQLite repositories back the manager fixtures.

Existing provider-attempt-context.ts and continuation modules accept explicit live
and captured domain dependencies. provisioning-ports.ts defines PreparedExecution
without importing public manager types. Its workflow constructor does no provisioning
calls; its entry returns the original dispatch inputs and preserves run-local accessors.
These are current patterns, not a new public API.

The canonical remaining roadmap assigns final facade/type consolidation to 33 and
full architectural qualification to 34. Inline trigger/revalidation delivery remains
assigned to 27, including its temporary source-size exception. No claim is made that
the complete manager rewrite is finished after provisioning.

## Saved inventory

| Symbol | Current lines |
|---|---|
| `deriveAgentAttempt` | 1089–1099 |
| `agentPhaseBucketKey` | 1101–1103 |
| `hasLatestPersistedAgentTerminalEventComplete` | 1105–1124 |
| `agentCompleteEventKey` | 1126–1140 |
| `persistedAgentCompleteEventKeys` | 1142–1156 |
| `hasAlreadyCountedCompleteEvent` | 1158–1173 |
| `bumpActivityTimestamp` | 2393–2403 |
| `touchHeartbeat` | 3411–3417 |
| `recordNotReportedMemoryUsage` | 4239–4241 |
| `processPod` | 5046–5798 |
| `consumeAgentEvents` | 5800–6444 |

The machine-readable inventory records exact captured/live/receiver references,
including shorthand-value symbols. Original function snapshots and all four state
construction declarations are saved alongside it. Baseline package/script hashes
remain frozen by Slice 23 qualification; this artifact changes documentation only.

## Related research

- 2026-10-18-pod-manager-provisioning.md
- 2026-10-18-pod-manager-continuation-goal-rework.md (historical; live source wins)
- ../plans/2026-10-18-pod-manager-remaining-roadmap.md

## Open questions

None for the current-state boundary. The concrete complete-boundary Slice24 plan is now saved at
../plans/2026-10-19-pod-manager-agent-execution.md under standing continuation authority.

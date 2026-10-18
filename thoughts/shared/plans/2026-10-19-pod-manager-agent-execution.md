# Slice 24: agent dispatch, stream consumption and run ownership

Status: PLANNED — authorized by the standing remaining-slices goal.
Date: 2026-10-19. Qualified source implementation: 38d70d53bf437e7920e92569a39143ddeae21c13.
Qualification/roadmap checkpoint: c0fef80b (same package/script bytes).
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-19-pod-manager-agent-execution.md.

## Outcome and authority

Complete milestone 24's whole execution boundary. Move the remaining processPod
lifetime/dispatch algorithm, consumeAgentEvents, terminal-accounting helpers and
active-run/activity ownership. Preserve the full public surface and original
policy, awaits, receiver semantics, error identity, provider/task/retry accounting
and cleanup. All later milestones (25–34) remain required. The user's remaining-
slices goal authorizes research, plan, implementation and qualification together;
these are evidence checkpoints, with no repetitive per-slice approval.

No model/account/API/schema/policy change, provider execution, live Docker/Azure,
tool installation, main integration, PR or deployment. Existing mocks/local migrated
SQLite/private filesystem boundaries are sufficient for this compatibility scope.

## Current state and full scope

The qualified manager is 10,296 lines. Slice 23 has already extracted complete
provisioning; its PreparedExecution/halted result feeds the remaining processPod.
Current source/line references use the qualified implementation above:

- processPod :5046–5798 (753 lines), including original guard/local state,
  preparation invocation, skip-agent/recovered terminal routes, runtime preflight,
  native Goal/rework/resume/fallback/fresh dispatch, event observation and ownership,
  post-execution credentials/completion and its entire original catch/finally.
- consumeAgentEvents :5800–6444 (645 lines), including durable initialization,
  lifecycle/provider/run ownership, cooldown/admission, the entire stream loop,
  completion replay/usage/budget accounting and nested finalization/settlement.
- Six static helpers :1089–1173: deriveAgentAttempt, agentPhaseBucketKey,
  hasLatestPersistedAgentTerminalEventComplete, agentCompleteEventKey,
  persistedAgentCompleteEventKeys and hasAlreadyCountedCompleteEvent.
- Original activeAgentRuns and activeAgentRunResolvers map initializers :2270–2280;
  original lastEventWriteAt and EVENT_TIMESTAMP_WRITE_THROTTLE_MS :2384–2385.
- Original bumpActivityTimestamp :2393–2403, touchHeartbeat :3411–3417 and
  recordNotReportedMemoryUsage :4239–4241; retain public heartbeat exposure.
- AgentRunOutcome exported union :787; preserve its public import path by re-export.

No runtime stream loop or process lifetime/error algorithm remains in manager after
this milestone. Completion algorithms and transition/activity emission remain assigned
25; resource/polling implementation remains assigned30; recovery controls31; facade
33. Existing calls to those algorithms cross explicit narrow function ports. Do not
pull them into a new catch-all module just to eliminate a callback.

## Concrete source and composition

Create six internal source files in packages/daemon/src/pods/:

1. agent-execution-contracts.ts owns AgentRunOutcome and explicit execution types.
   Define only observed live reads and captured domain callbacks/infrastructure;
   use original domain types or ReturnType of existing factories. Distinct captured
   interfaces for process and consumer prevent passing either the full manager or
   its dependency bag. Existing exported manager contracts stay in manager for33,
   except the AgentRunOutcome re-export. No new owner imports PodManager or
   PodManagerDependencies, directly or through a derived Pick/Parameters type.
2. agent-execution-policy.ts contains all six complete static helper bodies and
   parameter/default lists, unchanged except exports/import/type scaffolding.
3. agent-run-registry.ts exports createAgentRunRegistry(). Its original two map
   initializers produce activeAgentRuns and activeAgentRunResolvers, returned as the
   same objects used throughout the manager/provider/continuation/consumer paths.
4. agent-activity.ts exports createAgentActivity(live,captured). It contains the
   original lastEventWriteAt/10-second constant and three complete closure helpers.
   Capture podRepo/logger; read memoryUsageRepo at invocation on the original live
   object. Return the original map and original function references. Existing inline
   status/error emitters keep calling the same returned bump function. Public
   touchHeartbeat retains direct function exposure and its best-effort behavior.
5. agent-event-consumption.ts exports createAgentEventConsumption(live,captured).
   Move the entire consumeAgentEvents body and parameter/default list, unchanged.
   Capture the shared registry/activity maps, provider/context callbacks, execution
   projection, polling controls, pause map, transition/status callbacks, progress
   repo and other exact observed references. Keep the original live launch/provider/
   event/retry dependency reads. Retain summarizeAgentCompletionBlocker as a captured
   callback to its original manager helper (assigned25); do not import manager.
6. agent-process-workflow.ts exports createAgentProcessWorkflow(live,captured).
   Move the complete remaining processPod body unchanged, including provisioning's
   exact accessor port and original outer catch/finally. Its only dynamic receiver
   calls are triggerValidation, handleCompletion and consumeAgentEvents. Define an
   explicit AgentProcessCalls interface with these exact used signatures; the
   extracted function has an explicit TypeScript this parameter. Manager delegates
   with processWorkflow.processPod.call(this,podId). This retains late receiver reads,
   method overrides, argument arity/defaults and thrown/rejected behavior. Do not
   capture the public object or bind to a replacement object. No other body edits.

Every new source owner must stay below1,000 lines. The process algorithm is753 lines
and consumer645; their dependency/type scaffolding lives in the contracts file and
per-owner imports/factory setup. Check actual formatted sizes before qualification.
If a file exceeds the bound, review its coherent responsibility explicitly; never
hide a replacement monolith or split the original algorithm arbitrarily.

Replace each original active-map construction at its existing composition point
(before provider-attempt construction) with the registry factory/destructure. Replace
original activity-map construction at its existing later point with the activity
factory/destructure. Both constructors only allocate original state/functions; they
invoke no services and create no timers. Preserve the same instances passed to
provider attempts, continuation controls, pause/kill, process and consumer. The
original resolver and throttle cleanup algorithms move with the complete consumer.

Compose consumer/process owners before the public object, after all captured inputs
including provisioningWorkflow and continuation/credential/recovery helpers exist.
The process constructor does not read/invoke dynamic receiver commands. Static policy
imports are safe at existing early uses. Prune now-unused manager imports only where
removed bodies account for them; preserve all public type/shim exports and unrelated
source. The public methods become thin delegates; public signatures/defaults remain
compatible. No new algorithmic await or added proxy promise occurs inside old bodies.

## Phase 1: frozen characterization and exact recipes

Verify all2,026 Slice23 package/script hashes and six root controls before editing.
Freeze the complete public manager test file and its1,192 names/statuses. Reuse the
qualified Slice23 public-after report only with explicit unchanged-source provenance.
Save current manager, all eleven full functions (two methods/nine helpers), four
initializers, type union, exact live/captured/receiver reference inventory and original
map construction/call sites. The research inventory already handles shorthand values.
Generate complete expected source recipes before mutation. Allowed changes are only
module/import/export/type/factory scaffolding, explicit this typing, original instance
composition and thin delegates; original bodies/parameters/constant expressions stay.

Automated:
- [ ] Qualified predecessor hashes/public bytes and report provenance match.
- [ ] Complete eleven-body/four-binding/type/receiver/state recipe is saved.
Manual: none; standing continuation authority applies.

## Phase 2: implement and prove the complete boundary

Implement all six owners and manager wiring. Add focused suites:
agent-execution-policy.test.ts, agent-run-registry.test.ts, agent-activity.test.ts,
agent-event-consumption.test.ts and agent-process-workflow.test.ts. A new shared
test-utils/agent-execution-helpers.ts may build on existing mock infrastructure and
actual migrated repositories; do not edit existing assertions to suit the extraction.

Direct tests prove:
- Attempt index and phase keys, latest terminal/watermark behavior, completion hash
  fields, persisted replay key collection and already-counted telemetry boundaries.
- Registry factory isolation and shared exact map identity; settlement only clears
  its matching token, resolves its promise and clears polling/activity records.
- Activity throttle at exact boundary, status/heartbeat persistence, best-effort
  write failures, late memory usage dependency and unrelated-row preservation.
- Consumer admission rejects superseded binding/lifecycle before consuming; durable
  task/completion/provider/worker records settle on completion, fatal/throw/pause;
  duplicate accepted completions do not count usage twice. Pending run ownership,
  replacement callbacks and unverified termination retain original cleanup behavior.
- Whole process guard and prepared/halted flow; normal spawn, skip-agent/recovered
  terminal route, recovery/resume/rework/native Goal callbacks through controlled
  runtime boundaries as practical. Dynamic receiver overrides retain exact argument
  lists; unchanged public characterization covers all original dispatch branches.
- Startup admission visibility, archive finalization, caught error identity/classification
  and original failure parking through the actual extracted process and public facade.

Use at least three private-file SQLite cases with actual close/reopen: accepted
terminal/usage/provider/task history, unverified retained admission and failed startup
or superseded/pause recovery. Check integrity/FK and unrelated rows. Container/runtime/
provider/launch operations remain synthetic; local files are private and cleaned.
Control clocks/timers and release all deferred streams/promises without leaked state.

Run the unchanged public1,192 suite, all five direct suites, supplemental semantic
checks for new tests/fixtures, scoped Biome/whitespace and daemon/dependency build/
declarations. Stronger source semantic checks compare moved diagnostics against the
original baseline rather than silently repairing unrelated original-policy/types.
Retain initial failures and correct only extraction scaffolding or incorrect fixtures.

AST qualification must compare eleven complete bodies/parameters (ignoring only
explicit this typing), all four initializers, the union and complete file recipes.
Verify the original manager's unaffected source against its complete expected recipe;
all2,025 other predecessor package/script files and six root controls stay frozen.
Check no stream/process algorithm remains inline and all new source files<1,000.

Automated:
- [ ] Whole bodies/defaults/initializers/type and complete recipes preserved.
- [ ] Public1,192 names/statuses and assertion bytes identical; facade delegates pass.
- [ ] Five direct suites and three actual file-reopen cases pass with owner cleanup.
- [ ] Build/declarations, lint/whitespace and test semantics pass; no new source diagnostics.
- [ ] Same shared run/activity map instances; no process/stream loop remains in manager.
Manual: none for this bounded compatibility extraction.

## Phase 3: frozen regression qualification and continuation

Run all137 Slice23 affected suites plus the five new direct suites, deduplicated and
unfiltered, with SKIP_DB_TESTS=0. Include existing task/worker/startup retry, completion
journal, native Goal, polling/activity, runtime resume/parser and lifecycle suites if
not already selected. Record exact actual paths/counts before execution, retain the
three inherited gated collaborator skips and introduce none.

Freeze final package/script and root-control hashes. Commit/push implementation as
a qualification checkpoint, then run:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable task-local npx launcher,
frozen install without fallback/lock changes, all uncached groups and the existing
2 MiB root-lint processing limit only. No dependency, selection/config, skip or rule
changes. Actual expected test delta equals the new direct cases; use observed counts.
Match the same ten inherited full gated skips. Record limitations honestly.

Create .autopod-data/agent-execution/proof.json with claims, actual commands/results,
implementation revision, source/recipe/public hashes, state/SQLite evidence and actual
counts. Check frozen bytes after full pipeline, commit/push qualification docs and
verify clean local/remote identity. Update roadmap/count only once proven. Continue
25 (completion/transitions) under the same goal; the goal remains active through34.
Slice27 must still extract inline validation trigger/revalidation delivery and review
its temporary size exception.

Automated:
- [ ] Full affected set passes with real SQLite and no new skips.
- [ ] Full uncached frozen pipeline passes; actual counts/gates/environment retained.
- [ ] Exact final hashes and clean pushed revision match the tested implementation.
- [ ] Plan/roadmap mark24 only after proof and retain all25–34 finish gates.
Manual: none; integration/production acceptance remains separately authorized.

## Compatibility and rollback

Public import paths, receiver semantics and externally visible behavior remain.
No migrations or stronger atomicity/replay/termination guarantee. Revert manager and
all six new modules together for rollback. Tests and proof establish the local
compatibility boundary only. Final manager<=1,500 lines and full327-unit/73-member/
mutable-owner reconciliation are still required at33/34.

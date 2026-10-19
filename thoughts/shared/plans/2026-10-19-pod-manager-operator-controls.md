# Slice29: complete operator lifecycle controls

Status: COMPLETE — full frozen qualification passed; goal continues through34.
Date:2026-10-19. Baseline:c7997924e39d475d674f128c5030ae8afcb277b1.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-operator-controls.md.

## Outcome and authority

Complete29 across nine public commands, the entire488-line sendMessage lifetime,
static fallback formatter, shared pause intent state and quiescence constant. Move
allten complete bodies and both original binding initializers. Manager starts at6,157
lines. Preserve signatures/defaults, actors, admission/errors, credential boundaries,
MCP reply ordering, native Goal calls, recovery effects, cleanup fences and shared state.
No helper-only subset completes this milestone.

The standing user goal “the rest of the slices” and roadmap execution authority cover
research→plan→implement→qualify with commit/push checkpoints, without repetitive
per-slice approval. The previous goal turn made concrete progress:28 was implemented,
fully qualified and pushed;29 research is complete. No blocker. This concrete plan
precedes all29 product writes. Full goal remains active through34, with six remaining
milestones29–34 until29 qualification succeeds.

No schema/profile/state/API/product/security policy correction, extra replay/retry,
credential vending, external messages, paid/live provider/container operations, tool
installation acceptance, PR/main integration or deployment. Existing native alias
limitation recorded in28 remains. Called resource/network cleanup30, workspace/recovery31
and admission32 algorithms retain later ownership through narrow original callbacks.

## Current source and resolved design

Research names ten complete functions/methods and two bindings at the baseline above.
sendMessage uses live launchConfiguration and pendingRequestsByPod, pause uses live
launchConfiguration and kill uses live launchConfiguration/providerAttemptRepo. Pass
that same object through explicit narrow live interfaces. Do not snapshot/replace
those fields, shared pending objects or activeAgentRuns state at construction.

Only sendMessage/rejectSession/killAllFailed use dynamic this. Their required call
sets are respectively completion/approval/validation/event consumption; network refresh/
event consumption/completion; and killSession. The owner functions receive explicit
narrow this contracts and public delegates use .call(this,...), resolving actual
properties at the original later call sites. Keep complete original async bodies;
facade promise-returning delegates return owner promises without a new async proxy.

The488-line sendMessage body fits under1,000 lines with narrow contracts. Move it
whole, including host-fetch/host-push credential repair, inline PR delivery, direct
source-credential refusal, validation overrides, attached/detached/retained MCP replies,
budget approval and preserved-sandbox continuation. This is cohesive operator recovery
policy, with differences from validation/approval delivery in27; do not unify it or
move only convenient helpers. Outer catches, original await boundaries and deferred
auto-approval keep their original positions.

Kill checks deletion ownership, clears/stops preview and merge polling before canKill.
Keep that preliminary ordering. Preserve its30s local cleanup race and original
continuing cleanup/fences after timeout; do not claim stronger termination/isolation.
Pause keeps the original10s common deadline, active/replacement-run token checks and
release-on-settle intent behavior; each timer clears on success/timeout. Exactly one
pause-intent Map remains shared with agent event consumption.

## Nine domain source modules

Create under packages/daemon/src/pods/:

1. operator-policy.ts exports unchanged buildDetachedMcpFallbackMessage, including
   label/duplicate-warning wording. It has no dependencies or mutable state.
2. operator-state.ts exports createOperatorPauseState, containing the original
   pauseIntents = new Map<string,symbol>() binding and returning that exact map.
   Invoke at its old location immediately before createAgentRunRegistry. Export
   original PAUSE_QUIESCENCE_TIMEOUT_MS=10_000 at module scope; this pure primitive
   placement changes no mutable resource or observable initializer. Keep same map
   references in message/pause and existing event-consumption factory.
3. operator-messages.ts: createOperatorMessages(live,captured) returns original
   sendMessage with explicit OperatorMessageCalls this. Whole lifetime/body/defaults
   unchanged, including actor/audit/override/pending decision persistence, host-only
   auth and PR helper calls, native Goal admission, budget/completion, attached/detached
   MCP behavior, retained-run guard, fresh recovery worker and error identity.
4. operator-rejection.ts: createOperatorRejection(captured) returns original
   rejectSession with OperatorRejectionCalls this. Preserve original actor/defaults,
   status/rework/reset/feedback/network/container/resume/outcome and rollback rules.
5. operator-pause.ts: createOperatorPause(live,captured) returns unchanged pauseSession.
   Capture same pause map, active-run registry, timeout primitive and runtime/events.
   Preserve token-specific deferred release, suspend/native Goal handling, timeout
   reporting and sequential replacement-run quiescence without duplicate tracking.
6. operator-kill.ts: createOperatorKill(live,captured) returns original killSession.
   Retain local cleanup closure, generation checks, timeout/finally, credential recovery,
   sidecars/branches/container/network/runtime/worktree/host state cleanup, live attempt
   close, lineage forget and killed event. Constructor performs no cleanup/service call.
7. operator-controls.ts: createOperatorControls(captured) returns unchanged nudgeSession,
   notifyEscalation and killAllFailed; only bulk kill gets narrow OperatorBulkCalls
   this. Preserve queued messages, running-only escalation transition and sequential
   best-effort bulk result, with the original dynamic kill method calls.
8. operator-tools.ts: createOperatorTools(captured) returns original injectCredential
   and installCliTool. Preserve unconditional410 rejection and gh/az presence check,
   running/container admission and original provisioning-owned installer callbacks.
9. operator-contracts.ts: explicit observed captured/live interfaces and three narrow
   receiver contracts. OperatorWorkflowCalls includes only handleCompletion,
   approveSession, triggerValidation, consumeAgentEvents, refreshNetworkPolicy and
   killSession, with existing domain types/signatures. Each owner uses the appropriate
   Pick. Live message port exposes read/get Goal and pending map; pause exposes
   read/control Goal; kill exposes read/control Goal and attempt getActive/close.
   Reuse infrastructure types and factory Parameters/ReturnType for captured callbacks/
   active-run state, never public PodManager/PodManagerDependencies or a broad bag.

Only pod-manager.ts changes among predecessor package/script files. Compose all six
workflow factories before the public return object when original captured references
are initialized; constructors only bind references/functions. Pause map constructs
at its old site, before active-run registry/event-consumption capture. Existing startup
polling stays where it is and receives the same callbacks. Replace allnine public
bodies with thin delegates, preserving original signatures/defaults and .call(this,...)
for the three receiver-dependent methods. Imports prune only when unused. All nine
new source modules<1,000 lines; no hidden replacement monolith.

## Phase1: verified baseline and complete recipes

Verify2,097 qualified28 package/script hashes and six root controls. Save manager,
ten full bodies/defaults, map/timeout initializers, actual captured/live/receiver
references, constructor order and full expected source recipes. Freeze public test
bytes; reuse the qualified1,192 public report only with explicit matching provenance.
Allowed transforms: import/export/type/factory scaffolding, explicit narrow this
annotation, documented primitive placement, original-instance composition and thin
public delegates. No original body/parameter/default/initializer algorithm changes.

Automated:
- [x] Qualified predecessor hashes/root controls and public bytes/provenance match.
- [x] All ten-body/two-binding/reference/construction/full-source recipes saved.
Manual:none under standing continuation authority.

## Phase2: complete ownership and behavioral proof

Implement nine owners and manager wiring. Add operator-policy.test.ts,
operator-state.test.ts, operator-messages.test.ts, operator-rejection.test.ts,
operator-pause.test.ts, operator-kill.test.ts, operator-controls.test.ts and
operator-tools.test.ts. Shared test-utils/operator-helpers.ts reuses existing native
repository/mock infrastructure; predecessor helpers/assertions remain unchanged.
All runtime/provider/container/tool effects stay controlled and uncharged; no real
messages or installs. Release all promises/timers and private files.

Policy/state tests cover original fallback wording, one per-instance map, shared
identity and timeout. Message tests cover pause/native Goal admission, budget cap/
completion, host-fetch repair, host-push carry-forward/new PR/fix routing and parked
credential identity, no container credential vending, validation override dismissal/
guidance, attached/detached/retained MCP handling, actor/audit persistence and deferred
dynamic calls. Existing public suite remains required for the full inherited recovery/
provider/override/Goal paths; do not substitute a narrow owner test for it.

Pause tests exercise original active-run shared state, successful suspend/native
Goal control, duplicate intent admission, replacement-run wait,10s timeout and
release-after-settle on timeout/failure, with stale-token protection and zero remaining
owned timers. Rejection tests cover status admission, original reset/feedback, dynamic
network/event/completion receiver and superseded/error behavior. Kill tests cover
preliminary-effect ordering, validation abort, normal cleanup/effect/attempt/event
order, stale generation during cleanup,30s timeout and late cleanup, provider live
field replacement, timer clearing and original native Goal cancel handling. Existing
resource algorithms remain controlled callback ports, not newly duplicated owners.

Controls/tools cover nudge/notification eligibility, exact queue/escalation values,
sequential bulk successes/errors and receiver mutation, credential refusal without
container writes, existing gh/az detection, admission and installer callback selection.
At least three actual private-file SQLite close/reopen cases cover actor-labelled
reply/queued guidance/decision state, rejection/rework or completed kill history and
retained blocked/timeout state. Check integrity/FK and unrelated rows. Shared native
pending requests/termination state are used where practical; do not infer live worker
acceptance from mocked adapters or claim stronger isolation/replay/termination.

Run unchanged1,192 public cases, all eight new suites and inherited direct fix/
delivery/approval suites. Build daemon/dependencies/declarations; scoped Biome and
whitespace. Supplement all new tests/fixture semantics (zero diagnostics) and compare
moved source diagnostics against the complete old manager baseline, allowing only
inherited code/message diagnostics. Retain first failures; correct scaffolding/fixture
setup without weakening public assertions or repairing unrelated original policy.

AST audit allten whole bodies/parameters/defaults, both initializers, complete manager/
nine-module recipes, state construction/event capture and original startup polling.
Same73 public members, nine thin delegates, all operator algorithms in owners. All
2,096 other predecessor package/script files/six root controls stay frozen. Every new
owner<1,000 lines; mutable pause state has one explicit owner and tested release paths.

Automated:
- [x] Whole bodies/defaults/two initializers/startup/state/full recipes match.
- [x] Public1,192 names/statuses/assertion bytes pass; same73 public interface.
- [x] Eight direct suites and at least three actual SQLite reopen cases pass.
- [x] Build/lint/whitespace/new-test semantics pass; no new source diagnostic.
- [x] Complete operator lifetimes/domain ownership/shared state and release proven.
Manual:none for bounded compatibility; no live external acceptance claimed.

## Phase3: frozen qualification and next responsibility

Run all226 inherited affected suites plus new paths/missing immediate operator/pause/
escalation/credential/continuation collaborators, deduplicated/unfiltered with
SKIP_DB_TESTS=0. Save actual paths/command before execution. Freeze final hashes,
commit/push implementation, then:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2 with executable local npx launcher; frozen
install without fallback/lock mutation, all groups uncached. Retain only inherited
2MiB task-local root-lint processing allowance and existing82 warnings; no rule/config/
dependency/selection relaxation. Record actual delta from28's8,865 Vitest passes/
554 passing files/35Node script tests, same ten full gated cases and no new skips.
Recheck frozen bytes and apply prove-work to completed implementation, recording
.autopod-data/operator-controls/proof.json with actual tested revision, claims/evidence,
commands/results, state/reopen cases and limitations.

Commit/push qualification docs; verify clean local/remote identity. Mark29 only after
all gates pass; record30 resource/network/preview research. Goal remains active through
34's facade<=1,500-line/327-unit/73-member/mutable-owner cleanup reconciliation and
full frozen uncached clean pushed final proof. PR/main integration/deploy separate.

Automated:
- [x] Expanded regression passes with actual SQLite and no new skip.
- [x] Full frozen uncached pipeline passes; actual counts/runtime/gates recorded.
- [x] Frozen bytes, proof and clean pushed revision verified.
- [x] Plan/roadmap mark29 after proof and complete30 research is recorded.
Manual:none; production acceptance remains separately scoped.

## Compatibility and rollback

No migration, contract/policy or stronger replay/atomicity/termination guarantee. All
original async bodies/awaits/error paths/receivers remain; only the pure timeout
primitive moves to module scope. The same pause map stays at its creation point and
all constructors add no service effects/timers. Revert manager and nine owners together.
No unresolved design questions remain.

## Implementation checkpoint — 2026-10-19

Allten complete original bodies/parameters/defaults and both binding initializers
match; allten full manager/module recipes match. Same73 public members, allnine
thin delegates, three dynamic receivers and live launch/pending/attempt fields remain.
The one pause map constructs before the active-run registry and is captured by the
existing event owner and new message/pause owners; polling arguments/startup match.
All2,096 other predecessor package/script files and six root controls are unchanged.
Manager6,157→5,375 lines. Nine new source modules are6–548 lines.

The unchanged1,192 public names/statuses/assertion bytes pass. Eight new operator
suites plus21 inherited fix/delivery/approval suites pass130 cases:33new and97inherited.
Three actual private-file SQLite close/reopen cases cover actor reply/guidance/decision,
rejection/rework/history and completed kill/history, with integrity/FK checks. Pause
settlement/timeout/replaced tokens, kill generation/30s late-cleanup fencing and live
provider fields, attached/detached/retained decisions and dynamic receiver replacement
are directly exercised. These use real local state/repositories/ledgers/pending requests
and controlled runtime/container/Goal adapters; no live worker or installation claim.
Allnine new test/fixture files have zero semantic diagnostics; all24 changed-source
diagnostics match the original24 baseline. Build/declarations, scoped lint and
whitespace pass.

Initial noVoidTypeReturn delegate formatting, CommonJS audit names, stale nativeSessionId
import and fixture callback types are retained in named logs. Corrections affect only
scaffolding/types/fixtures; original algorithm bodies and public assertions remain
unchanged. Source/test bytes are frozen for affected/full qualification. Evidence:
.autopod-data/operator-controls/, including full recipes, movement.json, named reports/
commands/exits, public-comparison.json, baseline-type-comparison.json, test-types.json
and frozen-manifest.json. Expanded/full qualification and30 research remain required
before29 is complete. Goal remains active through34.

## Final qualification — 2026-10-19

Verdict: PROVEN for complete local compatibility extraction. Tested implementation:
5838a228ece085093fae33e30bd657c237ef91b6, pushed before full qualification. Evidence:
.autopod-data/operator-controls/proof.json and named reports/commands/scripts.

All237 affected suites pass:5,055 tests and four unchanged inherited infrastructure
gates. Full frozen uncached validation passes frozen install without fallback/lock
mutation, lint, build/declarations, typecheck, workspace tests, audit and secret scan.
8,898 Vitest tests pass across562 passing files, plus all35 Node script tests. Same
ten inherited full gated cases, no new skip. Actual Node22.23.3/pnpm9.15.4/SQLite3.49.2;
all observed Turbo groups are uncached(7/11/15tasks). The inherited task-local2MiB
root-lint input limit and82 existing warnings remain; no rule/config/dependency/
selection relaxation. All2,115 final package/script hashes and six roots match.

All1,192 public names/statuses/assertion bytes match. Final29-suite direct run passes
130 cases:33new operator cases across eight suites and97 unchanged inherited fix/
delivery/approval cases. Three real private-file SQLite close/reopen cases cover
actor-labelled reply/queued guidance/decision, rejection/rework/history and completed
kill/history; integrity/FK and unrelated profile checks pass. Actual local pending
requests, active-run registry and task ledger exercise attached/detached/retained
replies, pause settlement/replacement/10s timeout and kill replacement/30s late-cleanup
fences. Three dynamic receiver paths and live launch/pending/provider fields preserve
their contracts. External runtime/Goal/container/transport/install effects are controlled;
no live worker/provider, real messages, credential vending or installation acceptance.

Allten full bodies/defaults, both initializers and allten full source recipes match.
Same73 public members, nine thin delegates, one shared pause map created before active
registry/event capture and original delivery startup arguments/site remain. All24
changed-source supplemental diagnostics match the original24 baseline; nine new test/
fixture files have zero diagnostics. Manager6,157→5,375 lines; nine new source modules
6–548 lines. Original cleanup may continue after timeout, with no stronger isolation/
termination/replay/atomicity claim.28's native fix repository-alias limitation remains
preserved; this milestone does not repair it.

This completes29. Five milestones remain30–34. Complete resource/network/preview
research is saved at ../research/2026-10-19-pod-manager-resources-preview.md. The
concrete30 plan is saved at2026-10-19-pod-manager-resources-preview.md; it covers all25
bodies/13initializers, shared lifetime state, network protocol and four public controls.
Goal remains active through<=1,500-line facade/composition,327-unit/73-member/mutable-
owner reconciliation and34 full proof. PR/main/deployment remain separately scoped.

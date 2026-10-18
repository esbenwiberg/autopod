# Slice 13: validation progress events extraction

Status: COMPLETE — all three approved phases implemented and locally verified.
Date: 2026-10-18.
Baseline: 338c2476c76369a89130e7b3e044f1280b757efa.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Give validation phase/review event callbacks and their existing ownership-forwarding
wrapper one module. Preserve every event envelope, payload key, timestamp source,
synchronous boundary and stale-callback decision. This follows the established
characterize → extract → qualify structure. Approval covers all three phases together,
with no intermediate manual gate for this headless compatibility extraction.
Commit/push verified increments per the user's repository instructions.

## Current state and desired boundary

Research: ../research/2026-10-18-pod-manager-validation-progress.md.
Manager baseline: 17,244 lines. buildPhaseEventCallbacks occupies :5846–5911 (66 lines
including trailing blank); ownedValidationCallbacks occupies :6727–6743 (17 lines).
The first maps ten phase results and review snapshots to three event types. The
second checks the existing ownership object before optional callback forwarding.

There are four builder calls (ordinary, manual, independent council, advisory), two
direct wrapper calls (council and advisory), and one wrapper injection into
createValidationExecution. Existing blocking execution invokes that injected wrapper.

Advisory completion overrides the spread wrapper: manager merges its result, then
checks ownership before calling the raw completion callback. Preserve that entire
block and its history/current-result/readiness rules byte/token-equivalently.

Exactly two product paths change:
- New packages/daemon/src/pods/validation-progress.ts.
- packages/daemon/src/pods/pod-manager.ts: import/composition, removal of the two
  definitions and their moved comment, removal of nine now-unused type imports only.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-progress.test.ts: direct event and wrapper
  contracts plus actual SQLite/event-bus/ownership integration.

Manager keeps capture/claim/advisory ownership policy, controllers/maps, retry ledger,
engine dispatch, progress activity/heartbeat, advisory merge/history/readiness,
result publication, lifecycle transitions and delivery. Existing shared event/types,
engine, event bus/repository, WebSocket and desktop implementations remain unchanged.
No state/schema/API/dependency/UI change, added event, outbox, new transaction,
clock injection, stronger fence, concurrency policy or provider call is included.

## Implementation approach

Add createValidationProgress with one dependency:

    eventBus: Pick<EventBus, 'emit'>

It captures that same object and returns the existing names/signatures:

    buildPhaseEventCallbacks(podId: string): Required<ValidationPhaseCallbacks>
    ownedValidationCallbacks(
      ownership: ReturnType<typeof captureValidationOwnership>,
      callbacks: Parameters<ValidationEngine['validate']>[3],
    ): NonNullable<Parameters<ValidationEngine['validate']>[3]>

The factory return surface may use a private type alias for Required callbacks;
retain the original inner function signatures and both function bodies unchanged.
Use only type imports for EventBus, ValidationEngine/ValidationPhaseCallbacks,
captureValidationOwnership and the existing shared types. Construction and callback
creation perform no emission, clock read, ownership call or repository access.

Compose and destructure both names immediately BEFORE createValidationExecution,
after createValidationInputs. Keep the existing ownedValidationCallbacks shorthand
injection, all four builder calls and both direct wrapper calls unchanged. Do not
add a wrapper, await, catch, new ownership check, memoization or callback cache.

Move the four-line desktop-chip comment with its builder. Remove only these nine
manager shared type imports, verified to have no other use: BuildResult,
FactValidationResult, HealthResult, LintResult, PageResult, ReviewProgressSnapshot,
SastResult, SetupResult, TaskReviewResult. Retain ValidationPhase, ValidationResult,
ValidationEngine and captureValidationOwnership, which have other manager uses.

Compare parsed TypeScript for both exact original bodies, the complete manager and
new module against this explicit recipe. Allow typed factory wrapper/composition,
type imports/removals, definition/comment move and formatting only. No body receiver
substitution is required. Independently verify unchanged four builder calls, two
direct wrapper calls and the wrapper injection; guard/publisher callers stay intact.

## Compatibility requirements

1. Preserve event names, podId capture, phase/phaseStatus values and exact result-key
   mapping. Forward supplied status independently of payload status. Casts remain
   casts; do not validate, normalize, sanitize or clone in the new module.
2. Phase start/completion read Date when invoked, not when callbacks are built.
   Review progress uses progress.updatedAt verbatim and forwards the original object.
   Repeated calls produce fresh envelopes; preserve reference identity of payloads.
3. Preserve undefined versus null live payload keys and existing JSON omission on
   persistence. Unknown runtime completion phases emit nothing; start keeps its
   current forwarding. No generic result key/fallback branch is introduced.
4. Raw event callbacks do not independently check lifecycle ownership. Existing
   wrappers/caller guards decide whether they run. Do not imply all advisory writes
   are guarded by the moved wrapper: manager still merges before its completion guard.
5. Wrapper creates three synchronous functions even with absent callbacks. Every
   invocation checks isCurrent before optional callback/member lookup, preserves
   argument/reference and method receiver, looks up methods at invocation time,
   discards callback return values and adds no catch/await. Ownership can change
   between successive calls. No eager validation or assertCurrent substitution.
6. Capture the original eventBus/ownership/callback object references. Replacing a
   dependency slot does not replace a captured object; replacing a captured object's
   method is observed. Preserve exceptions by identity at the helper boundary.
7. Real event bus still persists first, optionally sanitizes, tags/subscribes and
   handles subscriber exceptions. Earlier events remain durable if a later insert
   fails. These helpers add neither a transaction nor new delivery guarantees.
8. Existing manager/engine outer error handling, retry admission/outcome settlement,
   lifecycle ownership, advisory history/cost and result readiness remain unchanged.

## Phase 1: characterize public progress and ownership

Only edit pod-manager.test.ts. Append `validation progress compatibility`, using the
existing migrated SQLite context and public triggerValidation/revalidateSession.
Do not import the future module or add production-only seams.

Pin both entry paths for phase-start/completion envelopes and all ten result keys,
status forwarding and live review progress timestamps. Observe events through the
actual event bus/repository and assert outside subscriber callbacks. Pin event order,
relevant live reference identity versus persisted JSON, validation history and final
state/attempt/engine/resume behavior. Fixtures return valid complete typed results.

Exercise a real ownership change during engine work (generation/container/status
or pending-decision changes via existing repositories). Send all three late callback
kinds after supersession; verify the prior prefix remains while new progress/results
cannot overwrite or stop the replacement. Reuse selected existing admission/ownership,
execution, council and advisory cases rather than rebuild their policies.

Pin advisory completion's existing merge-before-event order and stale/deferred
handling through public seams; retain manager's distinct historical evidence behavior.
Keep existing council callback wiring/ownership cases selected. Characterize targeted
event-insert errors after an earlier event was persisted, and throwing subscribers,
without failing unrelated setup/status/admission events. Freeze the actual differing
caller error outcomes from unchanged product; do not strengthen their policy.

Release/join held work in finally, unsubscribe, restore spies/clocks/env and close
private databases. Record initial diagnostics/corrections honestly. Freeze passing
public bytes, filter/names, manager source, runtime, baseline package/script and six
root-control hashes under ignored .autopod-data/validation-progress/.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen public assertions, before-source/runtime/hashes and raw results recorded.

Manual: None required for this local headless extraction.

## Phase 2: extract and prove exact event/callback contracts

Apply the exact two-product-file recipe. Keep Phase 1 assertions byte-identical.
Add validation-progress.test.ts importing the actual factory. Use fresh callback
objects and complete typed fixtures; deliberate malformed-runtime cases may use
narrow explicit casts/Object.assign without weakening production types.

Direct contract matrix:
- Factory, builder and ownership-wrapper construction have no collaborator/clock
  effects. Fresh builders/wrappers/functions are distinct and isolate captured podId.
- Ten start/completion mappings, all four phaseStatus values and status/payload
  independence; exact envelope keys, payload identity, repeat order and invocation
  clock. Progress preserves updatedAt/reference even if it differs from daemon time.
- Null fact/review/advisory, undefined payload, empty pages, arbitrary unknown payload
  forwarding and unknown runtime phase distinction. No extra fallback emission.
- All three owned callbacks forward current calls and suppress stale calls; check
  isCurrent every invocation, including missing callbacks. Preserve arguments,
  receivers, late methods, original captured objects and discarded return values.
  Controlled ownership/callback/bus errors escape by identity; no new async boundary.
- Combine the actual event bus/repository with private migrated FILE SQLite and
  actual captureValidationOwnership backed by real pod state. Observe persisted
  events before subscriber notification, event order/ids and stale suppression after
  generation/identity/status/pending-decision/invocation changes. Restore temporary
  fixture mutations; this proves the injected wrapper contract, while public tests
  prove actual manager controller/advisory rules.
- SQL insert abort after a persisted prefix: the callback throws, earlier events
  survive close/reopen, failed event is absent and subscribers were not notified for
  it. Subscriber failure follows existing bus policy. Run integrity/FK checks on
  reopened database and distinguish live references/undefined keys from stored JSON.

Keep real ownership/engine/bus/repository/WebSocket/readiness implementations
unchanged. Record exact body movement, unchanged calls/injection, resulting line
counts and all other baseline hashes. Do not claim a live desktop/rendered UI proof.

### Success criteria

Automated:
- [x] Frozen public checks pass unchanged after extraction.
- [x] Direct event/wrapper and real SQLite/bus/ownership/reopen checks pass.
- [x] Two-body recipe, unchanged calls/injection and two-product/two-test scope pass.

Manual: None required. No live Docker/Azure/provider call or Swift build required.

## Phase 3: qualify frozen final source

Use the predecessor task-local launcher with Node 22.23.3 / pnpm 9.15.4; verify child
Node and opened SQLite anew. Freeze final package/script and six root-control hashes.
Retain exact commands, raw logs/exits, actual counts/skips and diagnostics.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation progress compatibility|typed live review progress|setup phase completion|advisory|independent.*council|validation admission lifecycle ownership|validation execution compatibility'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-progress.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-progress.ts packages/daemon/src/pods/validation-progress.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 60-suite daemon affected set plus these THREE
distinct paths without name filters (63 suites):
- src/pods/validation-progress.test.ts (new).
- src/validation/local-validation-engine.test.ts (existing).
- src/api/websocket.test.ts (existing).

The inherited list is retained in .autopod-data/validation-infrastructure/affected-command.json;
copy its exact command and append only these verified distinct paths. If the private
receipt is unavailable, reconstruct it from the predecessor plan/evidence before
running and record the explicit resolved list. No invented ownership test path.

Run supplemental semantic diagnostics on both new test boundaries and the existing
Node desktop contract: npx pnpm exec node packages/desktop/Tests/review-progress-contract.mjs.
That source contract is not a rendered/compiled desktop test. Full validation includes
frozen install, lint, build, supported declaration typecheck, all tests, audit and
secret scan with SQLite enabled and no new skips. Reuse process-only Git maintenance
setting and root lint --files-max-size=2097152; no rule/file selection/config changes.
Preserve/investigate failures before unchanged reruns. Known default Git metadata-scan
race and audit-clock flake stay outside scope; do not fix unrelated code to pass.

Recheck final diff/recipe and frozen hashes. Record actual evidence/limits, complete
plan, commit/push verified increments, then confirm remote identity and clean tree.
Slice 12 results are baseline context, not substitute evidence for slice 13.

### Success criteria

Automated:
- [x] All 63 affected suites pass with SQLite and no new skips.
- [x] Full uncached validation and desktop source contract pass.
- [x] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [x] Complete plan/proof records actual results, limits and final pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove actual manager dispatch/ownership/advisory integration; direct
contracts pin serialization inputs, ownership forwarding and real SQLite persistence.
Controlled engine/container seams establish local behavior, not external availability.
No performance gain or new event reliability/ordering guarantee is claimed. Retain
synchronous callbacks and original surrounding awaits. No migration. Revert manager
composition and the new module together. Integration, PR and deployment are separate.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-progress.md.
Predecessor: 2026-10-18-pod-manager-validation-infrastructure.md (complete).
Sources: pod-manager.ts:5842–5911, :5993–6009, :6727–6743, :13498, :13662, :14572;
interfaces/validation-engine.ts; pods/validation-ownership.ts; pods/event-bus.ts;
pods/event-repository.ts; shared/src/types/events.ts:199–237; API WebSocket and
local-validation-engine tests; desktop review-progress-contract.mjs.

All three approved phases are complete. No manual acceptance remains.
Integration, PR creation and deployment remain separate work.

## Phase 1 observed results

36 new public cases and 70 selected existing cases pass against unchanged product
(106 selected total; 982 unrelated cases excluded by this selection only). Tests
exercise both public entries, all ten payload mappings, independent status forwarding,
review snapshot timestamps/reference identity, generation/container/status/decision
supersession, advisory merge-before-event visibility, event-insert failure prefixes
and bus subscriber isolation. Engine outer error outcomes remain distinct between
ordinary/manual entry. The first run passed; semantic diagnostics are zero.

Frozen public bytes/filter, unchanged manager source, 1,969 baseline package/script
hashes and six root controls are retained under .autopod-data/validation-progress/.
Actual child Node 22.23.3 opens SQLite 3.49.2; pnpm uses the existing pinned launcher.

## Phase 2 observed results

Extracted both unchanged bodies into the 122-line validation-progress.ts, with one
eventBus dependency. Manager is 17,154 lines (90 fewer). Parsed TypeScript proves
both exact original bodies, the complete manager against the explicit recipe, four
unchanged builder calls, two direct wrapper calls and one execution injection. All
1,967 other baseline package/script files are unchanged. No receiver substitutions
or product corrections were needed. Advisory merge-before-guard stays in manager.

Frozen 106 public checks pass unchanged after extraction. All 90 direct cases pass:
77 memory contract cases and 13 private migrated file-backed SQLite/event-bus/actual
ownership fixtures. These prove event keys/status/reference/timestamp forwarding,
fresh guards, optional callbacks/receivers/late methods, synchronous errors and
returns, persisted prefixes, SQL insert abort, reopen/integrity/FK and subscriber
isolation. Actual manager controller/advisory policy remains covered publicly.

Initial direct execution had two fixture failures: PodUpdates has no branch update
and executionTarget cannot change with a container attached. Both cases now simulate
persisted identity drift explicitly through private SQL and verify the changed field
through the actual repository; target drift retains the container. One mock receiver
needed its explicit TypeScript this annotation. Initial failures/diagnostics are
retained. No assertion or production policy was relaxed.

All 63 affected suites pass: 2,493 tests, zero skips. Scoped Biome/whitespace and
semantic diagnostics in both new boundaries are clean. The existing desktop progress
source contract passes (no Swift/rendered UI claim). Final source is frozen with
1,971 package/script hashes and six unchanged root controls before qualification.

## Phase 3: final qualification

Verdict: PROVEN for the approved local compatibility extraction under the documented
qualification environment. All phases are complete; no manual acceptance remains.

| Claim/check | Observed final evidence | Result |
|---|---|---|
| Public compatibility | 106 selected before/after checks, 36 new; assertions byte-identical | Passed |
| Event/callback/persistence contracts | 90 direct cases: 77 memory contract cases and 13 private file-backed SQLite/bus/ownership fixtures | Passed |
| Surrounding orchestration | 63 affected suites; 2,493 passed; zero skipped | Passed |
| Full uncached pipeline | Frozen install, lint, build, supported declaration typecheck, tests, audit and secret scan | Passed under documented environment |
| Vitest | 8,077 passed across 500 passing files; 10 existing gated skips | Passed with existing skips |
| Standalone Node scripts | 35 passed; zero failed/skipped | Passed |
| Desktop progress source contract | Review progress desktop contract OK; no Swift build/rendered UI claim | Passed |
| Source integrity | 1,971 package/script hashes plus 6 root control hashes unchanged through qualification | Passed |
| Exact movement and scope | Two original bodies, four builder calls, two direct wrappers and one execution injection; complete manager recipe; two product/two test paths | Passed |
| Scoped quality | Biome/whitespace clean; zero semantic diagnostics in both new test boundaries | Passed |

Tested implementation: e283f479357af99072a06a9b5ae9d7763a63732c. A following documentation-only commit
records qualification without changing qualified source/test bytes. Final remote
identity and clean-worktree confirmation are recorded privately after push.

Actual full command using the existing task-local npx launcher:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Actual Node 22.23.3 opens SQLite 3.49.2; pnpm 9.15.4. Build/typecheck/test groups
ran uncached. Frozen install succeeded without fallback or lockfile mutation.
Root lint retained 82 existing warnings while processing the large manager test
with only --files-max-size=2097152 added. Scoped files are clean; no rule/file
selection was disabled and no repository/global configuration changed. The inherited
maintenance.auto=false is process-only. The default-environment Git maintenance
metadata-scan race and audit-clock flake remain outside this extraction. The 10
existing gated skips remain; no new case was skipped. No source/test change was made
during final qualification. Initial direct-fixture diagnostics and final passing
results are retained with raw logs/exits.

The manager is 17,154 lines, 90 fewer. validation-progress.ts is 122 lines.
Parsed TypeScript comparison proves both unchanged bodies and the complete remaining
manager against the explicit recipe. Four builder calls, two direct wrapper calls
and the existing execution injection retain arguments/order. Ownership capture,
controller maps, advisory completion merge-before-guard order, history/cost/readiness,
engine policy and bus/WebSocket behavior remain under their original authority.
All 1,967 other baseline package/script paths are unchanged. No product correction
followed extraction.

Evidence is retained under ignored .autopod-data/validation-progress/: proof.json,
movement.json, baseline/frozen/root-control manifests, frozen public assertions,
before-source, exact-recipe/original-region copies and scripts, actual runtime and
qualification commands, before/after/build/direct/affected/full/scoped-Biome/type/
desktop-contract logs and exits, initial diagnostics and pushed identities.

Tests establish original live references/status/timestamp inputs, optional callback
and receiver behavior, fresh ownership checks, real event persistence before
notification, SQL abort prefixes, close/reopen integrity/FK checks and subscriber
isolation. Persisted branch/target drift is simulated explicitly in private SQLite;
read errors and external engine/container boundaries are controlled. Actual ownership
logic backs direct guards; actual manager tests cover controller/advisory policies.
The desktop check inspects its existing source contract; it does not prove rendered
UI or a Swift build. Local evidence does not establish live Docker/Azure/provider
availability or new atomicity, outbox delivery, fencing, crash recovery, cross-process
safety or event delivery guarantees.

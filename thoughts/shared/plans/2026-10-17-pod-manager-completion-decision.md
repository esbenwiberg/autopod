# Slice 6: completion decision extraction

Status: COMPLETE — all three approved phases implemented and locally verified.
Baseline: f84f255e57c90a194386e291d59b4b3012467537.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract the source completion decisions and their current actions into a typed
factory. The user accepted the next slice with the established illustrated plan
and characterize → extract → qualify structure. Approval of this concrete plan
authorizes all three phases together; the user explicitly approved this plan.
No intermediate manual check is needed for this headless compatibility boundary.
Commit and push verified increments per the user's repository instructions.

## Current state analysis

See ../research/2026-10-17-pod-manager-completion-decision.md. References below use
packages/daemon/src/ at the baseline. handleCompletion (:11108) already delegates
human holds and source preparation, and retains artifact admission/coalescing.
The contiguous decision tail (:11156–11244) reloads the pod/settings, derives
predicates, logs successful sandbox proof and chooses one of four outcomes.
Shared transition, cleanup, event, dependency and validation helpers serve other
paths. Their algorithms and other callers remain in place.

## Desired end state

handleCompletion retains native Goal/status admission, human holds, artifact
dispatch/coalescing and the preparation stop check, then delegates source decisions.
createCompletionDecision owns the exact existing decision tail, including fresh
reads, telemetry and actions. It does not introduce a new persisted decision,
publication receipt, validation engine or authority.

Exactly three product files change:
- New pods/completion-decision.ts.
- pods/pod-manager.ts: import, composition and tail delegation only.
- pods/completion-source.ts: export its existing CompletionSourcePreparation type
  (one export keyword; its body, fields and runtime behavior remain identical).

Tests change only pods/pod-manager.test.ts and new pods/completion-decision.test.ts.
No schema, lifecycle state, API, profile, dependency, provider, retry, fencing,
atomicity, cancellation, concurrency or output-selection policy changes. No live
pod/provider call, deployment, PR, main merge or integration of unrelated work.

## Implementation approach

Create createCompletionDecision with this returned operation:

    applyCompletionDecision(
      pod: Pod,
      preparedSource: CompletionSourcePreparation,
      triggerValidation: (podId: string) => Promise<void>,
    ): Promise<void>

Use a type-only import of the existing exported preparation interface. Derive local
podId from pod.id and destructure the three observations at operation entry.
Move the entire contiguous tail beginning with the Finish or skip validation
comment through the final awaited trigger. Keep local names and branch bodies.
The sole moved-body receiver adaptation is this.triggerValidation(podId) becoming
triggerValidation(podId). Do not create a pure selector plus a second branch table:
the existing actions and their order belong with these decisions.

Use these 11 narrow existing dependencies:

- podRepo: Pick<PodRepository, 'getOrThrow'>.
- executionForPod(pod: Pod): PodExecutionSettings.
- isPodValidationDisabled(pod: Pod): boolean.
- getPodValidationSuite(pod: Pod): NonNullable<PodOptions['validationSuite']>.
- reworkInProgressPrefix: string, composed from REWORK_IN_PROGRESS_PREFIX and
  destructured with that existing uppercase local alias in the factory.
- cleanupContainer(pod: Pod, label: 'no-changes-complete'): Promise<void>.
- transition(pod: Pod, to: 'failed' | 'complete' | 'validating' | 'validated',
  extraUpdates?: Partial<Pick<PodUpdates, 'completedAt' | 'lastCorrectionMessage'>>): Pod.
- emitPodCompletedEvent(pod: Pod, filesChanged: number): void.
- maybeTriggerDependents(pod: Pod): void.
- emitActivityStatus(podId: string, message: string): void.
- logger: Pick<Logger, 'info'>.

Keep the shared helpers and constant in the manager. Compose the factory after
createCompletionSource without invoking helpers or doing I/O during construction.
Replace the manager's prepared-source destructure and complete tail with:

    await applyCompletionDecision(pod, preparedSource, (id) => this.triggerValidation(id));

The arrow closes over the current handleCompletion receiver. Lookup and invocation
of its current triggerValidation occur at the original final branch, rather than
capturing/binding a method at factory construction. All preceding admission and
source preparation remain byte-equivalent except import/composition/formatting.

## Compatibility requirements

1. Reload pod and resolve settings after preparation, before policy or telemetry.
   Preserve original pod target/worktree reads versus refreshed fields exactly.
   Missing local worktree does not become a zero-change observation.
2. Preserve fork detection (linked ID or non-default non-null base), its lack of
   default-branch fallback, scheduledJobId !== null, and exact Rework startsWith rule.
3. Preserve validation disabled precedence: skipValidation OR validate:false OR
   suite:off. Preserve getPodValidationSuite activity selection independently.
4. Preserve branch order: unchanged enabled ordinary Rework fails; scheduled Rework
   can complete; enabled no-change non-fork completes; bypass can reach validated;
   remaining cases validate. A disabled fork can bypass. Changed sandbox source
   forces validation even with skip/off and must not be inferred from stored zeros.
5. Direct completion awaits cleanup, transitions, emits completed with zero and then
   notifies dependents using the transition result. Rework failure retains resources
   and its timestamp/message. Bypass transitions validating, reloads, then validated
   with correction cleared and notifies dependents, without completion cleanup/event.
6. Preserve all telemetry expressions and bounded proof strings exactly, including
   summary flags which do not encode every later Rework/disabled branch. No telemetry
   correction is hidden in this extraction. Missing proof fields keep null fallbacks.
7. Preserve thrown/rejected collaborator behavior and partial effects. Do not add
   catches, rollback, ownership rechecks or deduplication. Hold promises to verify
   ordering; do not use fixed sleeps. No new crash/concurrency guarantee is claimed.

## Phase 1: characterize public decision behavior

Only change pods/pod-manager.test.ts. Add a completion decision compatibility group
using its existing real SQLite context, public handleCompletion and infrastructure
seams. Do not import the future module or add product test hooks. Reuse adequate
existing cases instead of copying them. Freeze final assertions and baseline source
identities under ignored .autopod-data/completion-decision/.

Cover representative combinations, with explicit expected outcomes:
- Local zero/nonzero changes; stale cached counters refreshed by preparation; zero
  stored files without a worktree. Assert state, timestamp/correction, validation
  invocation, cleanup, completion event and dependent eligibility where applicable.
- Rework prefix matches/misses; ordinary failed no-op, scheduled successful no-op,
  linked and non-default-branch forks, default-branch/non-fork and disabled variants.
- Each disable mechanism independently, explicit suite precedence combinations,
  and unchanged forks with enabled versus disabled validation. Check activity text.
- Sandbox changed/unchanged versus contradictory stored counters; changed source
  with each disable mechanism must still enter validation; unchanged ordinary/fork/
  scheduled Rework preserve existing exceptions. Incomplete proof remains blocked
  by preparation and never reaches a decision/cleanup/validation branch.
- Direct completion: hold controlled cleanup and observe no terminal transition,
  completion event or dependent enqueue until released. Then assert actual event
  and enqueue order, including fan-in/shared-branch eligibility through real helpers.
- Bypass: observe actual validating → validated events and reload-dependent state,
  correction clearing, no completed event or completion cleanup. Failure paths stop
  later actions rather than appearing as successful terminal work.
- Successful sandbox telemetry keeps exact predicate/summary expressions, truncated
  proof fields and messages, especially unchanged Rework where summary differs from
  the actual failed branch. Original-target/refreshed-data split stays observable.
- Replace/spy on triggerValidation after manager creation and during held preparation;
  confirm final branch invokes the current method with the manager as receiver,
  awaits settlement and propagates rejection unchanged. Settings/read errors propagate.
- Existing Goal/status/human/artifact fast paths still bypass source decision work.

Close DBs, restore spies/environment/timers and release/join held work in finally.

### Success criteria

Automated:
- [x] New public cases pass against unchanged product baseline.
- [x] Relevant existing completion/source/human/artifact/fork/schedule cases pass.
- [x] Raw results, runtime and before-source/test hashes are retained.

Manual: None required.

## Phase 2: extract and verify decision effects

Apply only the three-file product recipe. Keep Phase 1 assertions byte-identical.
Add completion-decision.test.ts using actual temporary file-backed SQLite and real
pod repositories with migrated schema. Control external helper callbacks; do not
claim those controlled callbacks prove actual provider cleanup or dependent queuing.
Use validateTransition with repository writes for a test transition adapter; public
manager cases retain responsibility for the actual shared transition implementation.

Direct boundary evidence:
- Read an original pod, persist changed decision inputs, invoke the operation and
  demonstrate it uses refreshed state/settings where the existing code does, while
  retaining original target/worktree reads. Pin missing/default branch distinctions.
- Exercise all four outcomes. Inspect persisted status, correction and completedAt
  after actual close/reopen, plus integrity_check and foreign_key_check.
- Hold controlled cleanup; verify no transition/event/dependent action before release
  and exact order/arguments afterward. Return a distinguishable current pod from
  transition and prove completion/dependent callbacks receive that returned object.
- For bypass, change a harmless persisted field when validating is recorded and
  verify the second transition receives the fresh reloaded pod. No completed event.
- Controlled read/settings/cleanup/transition/completed/dependent/validation failures
  preserve error identity, preceding durable effects and absence of later effects.
  These probes describe existing partial effects; they do not imply rollback.
- Pin exact successful proof telemetry and cases with absent optional host proof.
  Artificial preparation observations test this operation's contract, not Git proof.
- Factory construction has no effects; trigger callback only runs for the final
  branch and its promise is awaited. Other paths do not touch it.

Compare parsed TypeScript AST tokens against the baseline movement recipe, accounting
only for wrappers, imports/composition, local pod ID/destructure, callback receiver
adaptation, export keyword and formatting. Compare the remaining manager too.
Confirm no source-preparation runtime or shared helper implementation changed.

### Success criteria

Automated:
- [x] Byte-identical public characterization passes after extraction.
- [x] Direct persisted decision effects, ordering and failure probes pass.
- [x] Movement receipt matches the exact recipe across all three product files.
- [x] Only the three approved product paths and two test paths differ from baseline.

Manual: None required. No live provider/container qualification is claimed.

## Phase 3: qualify frozen final sources

Use the established task-local npx launcher (Node 22.23.3 / pnpm 9.15.4); confirm
actual child runtime and an opened SQLite DB. Freeze final package/test/script
hashes, retain raw logs/exit codes under .autopod-data/completion-decision/, and
compare hashes after validation. Keep previous slices' proof folders intact.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'completion decision compatibility|completion source compatibility'

Run slice 5's exact 27 affected suites plus completion-decision.test.ts, existing
configuration/series-launches.test.ts and pods/state-machine.test.ts (30 total):

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/completion-human-gate.test.ts src/e2e.test.ts src/pods/attached-reply-delivery.test.ts src/pods/operator-guidance-delivery.test.ts src/db/unit-of-work.test.ts src/pods/validation-workspace.test.ts src/worktrees/graft-reconcile.test.ts src/worktrees/sandbox-reconcile.test.ts src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts src/pods/completion-source.test.ts src/worktrees/local-worktree-manager.test.ts src/worktrees/local-worktree-manager.git.test.ts src/worktrees/auto-commit-message.test.ts src/pods/completion-decision.test.ts src/configuration/series-launches.test.ts src/pods/state-machine.test.ts
    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/completion-source.ts packages/daemon/src/pods/completion-decision.ts packages/daemon/src/pods/completion-decision.test.ts
    git diff --check
    TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use the supported build/declaration-typecheck pipeline. Require successful frozen
install; fallback lockfile mutations are not a qualified unchanged-dependency run.
Record actual counts/skips, failures and corrections, without copying prior counts
as new evidence. Commit/push verified increments per repository instructions;
record tested implementation/final documentation/remote identities separately.
Update this plan with observed evidence and exact remaining limitations.

### Success criteria

Automated:
- [x] All affected suites pass with SQLite included and no new skipped cases.
- [x] Full uncached install/lint/build/typecheck/test/audit/secret pipeline passes.
- [x] Runtime, source hashes, raw results and exact movement review are recorded.
- [x] Scoped lint and whitespace pass; verified commits are pushed; remote matches.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance and migration

Public characterization qualifies real manager wiring, events, transitions and
dependent behavior. Direct SQLite tests substantiate persisted outcomes and ordering
at the extracted boundary; controlled helpers do not prove live infrastructure.
Existing source/Git/checkpoint tests remain the source authority evidence. No new
fencing, deduplication, atomicity or recovery guarantee is introduced.

The factory adds no I/O, commands or retries. Preserve original awaits and invoke
the validation callback inside the moved tail; do not add a second returned-decision
await before validation admission. No performance improvement is claimed.
No schema/config/API migration. Roll back manager wiring, new module and type export
together. Integration with concurrent main work remains separate requested work.

## References and next action

- Research: ../research/2026-10-17-pod-manager-completion-decision.md.
- Predecessor: 2026-10-17-pod-manager-completion-source.md (complete).
- Existing factories: pods/completion-source.ts and pods/completion-human-gate.ts.
- Existing collaborators: pods/pod-repository.ts, pods/state-machine.ts and the
  shared manager transition/cleanup/completion/dependent helpers.

All three approved phases are complete. No manual acceptance remains for this
headless compatibility extraction. Integration, PR creation and deployment remain
separate requested work; none was performed.

## Phase 1 evidence

42 new public decision cases and 87 selected existing cases passed against unchanged
product source: 129 passed, 756 name-filtered. Assertions cover all four outcomes,
independent linked/base forks, scheduled Rework, each disable mechanism and suite
precedence, contradictory sandbox counters, bounded telemetry, held cleanup and
fan-in/shared-branch eligibility, fresh bypass state, late method receiver/await/error
behavior and settings failure. Runtime actually opened SQLite under Node 22.23.3;
pnpm is 9.15.4. Frozen assertions, before-source manifests and raw logs are under
ignored .autopod-data/completion-decision/.

Two initial runs exposed fixture issues, retained in their failure logs: linked
membership must be set at creation and reference an existing parent; inherited full
suite must be cleared to exercise the validate:false fallback-off activity. Fixtures
were corrected before freezing. No product change or weakened behavioral expectation
was used to obtain the passing baseline.

## Phase 2 evidence

All 129 selected public cases passed with the byte-identical frozen characterization
after extraction. All 29 direct boundary cases passed on their first run with real
file-backed SQLite close/reopen, integrity and foreign-key checks. They establish
persisted outcomes, original/refreshed input distinctions, no default-branch fallback,
cleanup and validation waits, returned-object forwarding, fresh bypass reloads and
partial effects/error identity across nine controlled failure sites. Synthetic helper
callbacks remain explicitly controlled; actual manager helpers are exercised publicly.

The 147-line createCompletionDecision module retains the contiguous decision tail
with one validation receiver adaptation. Manager shrank 75 lines, from 17,811 to
17,736. Parsed TypeScript token comparison matches both module and remaining manager;
completion-source.ts differs only by its type export. All 1,952 other baseline
package/script files are unchanged. Public test hash matches the baseline.

Daemon/dependency ESM and declaration build passed. Scoped Biome over all five
source/test files and whitespace checks passed. Supplemental TypeScript semantic
diagnostics restricted to the new direct test and new public group returned zero;
this is not a claim that unrelated repository test typing is clean.

## Phase 3: final verification

Verdict: PROVEN for the approved local compatibility extraction. All required
automated checks passed; no manual gate remains.

| Claim/check | Observed evidence | Result |
|---|---|---|
| Public compatibility | 129 selected cases pass before and after; assertions byte-identical | Passed |
| Persisted decision effects | 29 direct SQLite cases: close/reopen, integrity/foreign-key checks, ordering and failure effects | Passed |
| Surrounding orchestration | 30 affected suites, 1,318 passed, zero skipped | Passed |
| Full uncached pipeline | Frozen install, lint, build, repository typecheck, tests, audit and secret scan | Passed |
| Vitest | 7,473 passed across 493 passing files; 10 existing skipped cases | Passed with existing skips |
| Standalone Node scripts | 35 passed, zero failed/skipped | Passed |
| Source identity | All 1,957 frozen package/script files unchanged through qualification | Passed |
| Scope and movement | Three product paths, two test paths; exact movement recipe; all other baseline source unchanged | Passed |
| Scoped quality | Five-file Biome and whitespace clean; zero semantic diagnostics in new test code | Passed |

Pipeline body: TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh, using the
established task-local npx launcher. Actual Node 22.23.3 opened SQLite 3.49.2;
pnpm is 9.15.4. Build/typecheck/test Turbo groups ran uncached. Frozen install
succeeded without fallback. Repository lint retains its existing warnings; the
five changed source/test files have no scoped Biome diagnostics. No new skip was
introduced. Existing skips retain their Docker/platform/live-model gates.

Tested implementation: 03844471a47dbab15e107d94aca5e24e77488fa3. A following documentation-only commit
records the evidence without changing these tested product/test sources. The final
documentation/remote identity and clean-worktree confirmation are recorded in private
proof after push. Public baseline fixture failures remain recorded as failures;
no production or assertion changes were needed after extraction.

The 147-line factory owns the existing decision tail. Manager is 17,736 lines
(75 fewer). Preparation behavior changes only by exporting its existing interface.
Late validation lookup preserves the current manager receiver, admission timing
and awaited rejection behavior. Source algorithms, shared helper bodies and all
remaining manager policy match the approved recipe.

Evidence under ignored .autopod-data/completion-decision/: proof.json, movement.json,
baseline/frozen manifests, frozen characterization, before-source and expected-move
copies, runtime/pnpm records, before/after/build/affected/full-validation/scoped-Biome
logs, new-test-types.log, retained fixture-failure logs and remote commit identities.

Limits: actual SQLite substantiates persisted decision effects; controlled helper
callbacks substantiate this boundary's call order/arguments and partial failures.
Public manager cases exercise real shared helpers around mocked infrastructure.
Earlier source/Git/checkpoint suites retain their source-authority responsibility.
No live Docker/Azure/model-provider qualification, deployment, main integration,
new atomicity, lifecycle fencing, deduplication or crash/concurrency guarantee.

### Qualification environment adjustment

The default full pipeline failed one unchanged managed/source-delivery.test.ts
case: Git 2.56.0 removed objects/maintenance.lock between readdir and lstat during
ManagedGitBroker.freeze. The isolated unchanged 26-case suite reproduced the same
after-pr failure (25 passed). Its source and source-git/source-delivery dependencies
match the baseline; the approved extraction does not touch these implementations.

With automatic maintenance disabled only in the qualification process, all 26
source-delivery cases passed and the complete pipeline was rerun. Actual final
command (in addition to the documented Node/pnpm PATH harness):

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

No global or repository Git configuration, product source or assertions changed.
The default run is recorded as failed, not relabeled as a pass. This environment
adjustment prevents background maintenance in inherited test fixture Git processes;
it does not fix or qualify the unchanged metadata scanner against concurrent Git
maintenance. That existing race remains a separate limitation.

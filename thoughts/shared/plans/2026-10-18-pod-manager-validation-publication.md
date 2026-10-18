# Slice 11: validation result publication extraction

Status: COMPLETE — all three approved phases implemented and locally verified.
Date: 2026-10-18.
Baseline: 37d968d1f95beefba300b20df87eb98e695a4f75.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Give completed-attempt publication one focused synchronous module: save result,
accumulate review usage, insert history, then emit completion. Both ordinary and
manual validation already execute equivalent blocks. Keep the current order and
partial persistence when a later step fails.

Use the established characterize → extract → qualify structure. Explicit approval
covers all three phases together, with no intermediate manual acceptance required
for this headless compatibility extraction. Commit/push verified increments per
the user's repository instructions. Planning does not change product code.

## Current state analysis

Research: ../research/2026-10-18-pod-manager-validation-publication.md.
At baseline the manager is 17,399 lines. The ordinary publication block is
pod-manager.ts:13612–13645, immediately AFTER collectValidationEvidence. The manual
block is :14708–14740. They are 34 and 33 lines including trailing blanks. Bodies
match after comment/format removal and exactly two manual-local renames:
existingUsage→existing and prevReview→prev.

Both write lastValidationResult, select taskReview.tokenUsage ?? reviewTokenUsage,
aggregate usage from a fresh stored pod, optionally insert history, then synchronously
emit pod.validation_completed. They retain validationRecord for council/advisory
updates. Caller-specific pod reloads, terminal checks and decisions follow outside.
A similar sandbox-unavailability branch at :13522 has no usage accounting; leave it.

## Desired end state and scope

Exactly two product paths change:
- New packages/daemon/src/pods/validation-publication.ts.
- packages/daemon/src/pods/pod-manager.ts: import, factory composition and replacement
  of exactly the two identified publication blocks with synchronous delegations.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-publication.test.ts: direct contracts and
  real SQLite result/usage/history/event persistence proof.

The manager retains evidence collection, finalizing activity, ownership/controllers,
pre-check unavailability handling, terminal/status reloads, summaries, overrides,
classification/parking, independent councils, advisory work, correction and delivery.
Existing repositories/event bus and all their implementations/callers stay unchanged.
No new state/schema/API/profile/dependency, usage policy, transaction/outbox, ownership
fence, retry/deduplication, provider call, PR, main integration or deployment.

## Implementation approach

Create createValidationPublication with three narrow collaborators:
1. podRepo: Pick<PodRepository, 'update' | 'getOrThrow'>.
2. validationRepo?: Pick<ValidationRepository, 'insert'>.
3. eventBus: Pick<EventBus, 'emit'>.

Use existing type imports only: ValidationResult from @autopod/shared and repository/
event interfaces from their modules, including existing exported StoredValidation.
No new export from pod-manager.ts, shared types or repositories. No new production
clock/failure hooks. Factory construction performs no I/O or collaborator calls.
Capture the same object references at construction; keep their method lookup timing.

Return this SYNCHRONOUS operation (no async keyword, Promise or await):

    publishValidationResult(
      podId: string, attempt: number, result: ValidationResult,
    ): StoredValidation | undefined

Use the exact ordinary block as its body, retaining local validationRecord and
adding return validationRecord after eventBus.emit. The two locals in the manual
block normalize to the ordinary names only; verify that these are its only expression
changes before replacing it. Preserve native Date timestamp creation at the current
point. Do not use addTokenUsage, combine writes or change optional field omission.

Compose immediately after createValidationEvidence. Both original locations become:

    const validationRecord = publishValidationResult(podId, attempt, result);

No await, wrapper, new status read or extra publication is introduced. Keep each
following s2 declaration exactly where it was. Returned record identity and optional
undefined behavior remain available for existing council/advisory updates.

Compare parsed TypeScript tokens of the complete remaining manager and new module
against this recipe. Independently compare the original two blocks after only the
two specified local-name substitutions and comment/format removal. Allow typed
imports/wrapper/composition, two delegations, return and formatting only.

## Compatibility requirements

1. Keep result write → optional fresh usage read/write → optional history insert →
   event emission. Maintain synchronous execution, call counts and original result
   reference. No new scheduling point or transaction surrounds these operations.
2. Keep nullish usage priority, zero-valued selected objects, fallback without a
   verdict, accumulation into prior review usage, other phase buckets, and strictly
   positive cache/cost inclusion. Do not normalize unusual numeric values, preserve
   extra review keys, infer missing usage or add deduplication.
3. Preserve the fresh usage read AFTER result persistence. Retain all partial effects
   and error identity/precedence when any write/read/insert/emit fails; the caller's
   original outer catch remains responsible. No local catch, rollback or retry.
4. Optional history absence skips only history. Return the actual record returned
   by insert, including id/sequence/cycle, without copying or replacing it. Downstream
   council/advisory paths must keep updating the original immutable history row.
5. Event timestamp is created after history insertion. Emit the original result
   reference; keep existing event-bus persistence/sanitization/subscriber behavior.
   Subscriber exceptions caught by the real bus differ from an escaping emit failure.
6. Keep caller reload/status checks AFTER publication, including changes made by a
   synchronous subscriber. Publication may already be saved when the caller sees a
   terminal pod. Do not add stale-result fences or stronger recovery guarantees.
7. The early sandbox-unavailability path, adjudicated result replacements and advisory
   usage/evidence updates remain separate and byte/token-equivalent under the recipe.

## Phase 1: characterize both public publication paths

Only edit pod-manager.test.ts. Add a `validation publication compatibility` group
using public triggerValidation/revalidateSession and the existing migrated SQLite
manager context. No future-module import or new product seam. Use controlled engine
results and existing repository/event methods for observations/failure injection.

Cover both entry paths where applicable:
- No usage, task-review usage, metered fallback without a verdict, both fields present
  with priority, selected zero usage and accumulation across prior review/other phase
  buckets. Assert stored values and exact optional field shape.
- In a real completion-event subscriber, inspect stored result, usage, history and
  persisted event. Verify completed-attempt publication order, one initial history
  row/event, original result identity and caller behavior after subscriber status change.
- Missing validationRepo still emits and saves result/usage. Test optional history
  capture at manager construction, and current method lookup on retained objects.
- Controlled failures at result update, usage read/write, history insert and completion
  event persistence: record actual prior durable effects and original outer handling.
  Restore spies and do not inject failures into unrelated setup/provenance writes.
- Retain selected existing review-cost, metered-fallback, evidence-publication,
  recurring-finding auto-hoist and advisory completion cases to pin returned-row wiring.
  Observe actual supported behavior; do not force identical caller return/error handling.

Close private databases; unsubscribe callbacks and restore spies/clocks/env. Freeze
passing public assertions, selected names, all baseline package/script hashes, root
control hashes, actual Node/pnpm/SQLite and raw before results in ignored
.autopod-data/validation-publication/. Preserve initial failures and fixture corrections.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen assertions/source/runtime and raw before evidence are recorded.

Manual: None required for this headless local extraction.

## Phase 2: extract and prove durable publication effects

Apply the exact two-product-file recipe; frozen public assertions stay byte-identical.
Add validation-publication.test.ts importing the actual factory. Use private migrated
FILE-BACKED SQLite with actual pod, validation and event repositories and real event
bus. Reopen the database to inspect result, usage, history and events; run
integrity_check/foreign_key_check. Keep synthetic engine results clearly local.

Direct proof matrix:
- Construction has no side effects; exact ordering/arguments, synchronous return and
  no Promise; original result reference and actual returned StoredValidation identity.
  Optional history absence, captured references and late method lookup.
- Usage priority/fallback/no-usage, zero selected usage, absent prior map/review bucket,
  accumulated input/output/cache/cost, zero or negative cache/cost omission, preserved
  non-review buckets and current review object reconstruction. No policy improvement.
- Actual repeated attempts and attempt reset: persisted sequence/cycle/id correctness
  and cumulative usage after close/reopen. No new idempotency assumption.
- Controlled Date verifies timestamp after history insert. Subscriber inspection sees
  persisted state; subscriber result mutation leaves prior JSON snapshots unchanged.
  Subscriber status mutation is visible immediately; subscriber exception is isolated
  by real bus and does not make publication fail.
- Real SQL triggers selectively fail result update, usage update, history insertion or
  event insertion. After close/reopen, prove exactly which earlier effects remain and
  that later operations/subscribers did not run. Distinguish repository-local atomicity
  from atomicity of the whole publication sequence. Remove temporary triggers cleanly.
- Controlled getOrThrow/insert/emit failure probes cover error identity and boundaries
  that SQL alone cannot express. A successfully written history row survives a later
  event failure; a failed history insert rolls back its own row, not prior pod writes.

Use existing collaborator methods for fault probes; no production-only hooks or clock
injection. Public tests prove actual manager composition and returned-row consumers;
direct tests prove synchronous contract and persisted effects. Record exact movement,
actual line counts and all unchanged baseline package/script paths.

### Success criteria

Automated:
- [x] Frozen public checks pass unchanged after extraction.
- [x] Direct synchronous contracts and real close/reopen/SQL-failure persistence checks pass.
- [x] Exact movement, preserved adjacent paths and two-product/two-test scope pass.

Manual: None required. No live container/provider claim.

## Phase 3: qualify frozen final source

Use the existing task-local launcher: Node 22.23.3 / pnpm 9.15.4; confirm actual child
runtime and opened SQLite. Freeze final package/script and root control hashes.
Retain raw commands, exits, actual counts/skips and initial failures/corrections.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation publication compatibility|existing review writes still land|attributes metered review calls|validation evidence compatibility|runs recurring-finding auto-hoist|advisory completion preserves validation evidence|readiness refresh updates after deferred advisory finishes'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-publication.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-publication.ts packages/daemon/src/pods/validation-publication.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 52-file affected set plus these four distinct paths,
without name filters (56 suites):
- src/pods/validation-publication.test.ts (new in Phase 2).
- src/pods/event-bus.test.ts.
- src/pods/event-repository.test.ts.
- src/pods/token-telemetry-repair.test.ts.

Save the expanded affected command. Run full validation uncached with successful
frozen install, unchanged lockfile, lint, build, supported declaration typecheck,
tests, audit and secret scan. Keep SQLite enabled and no new skips. Supplemental
semantic checking covers new test boundaries without claiming old test typing repaired.

Carry the documented process-only maintenance.auto=false and root lint processing
limit --files-max-size=2097152. Do not change repository/global configuration or
rules/file selection. Preserve/investigate failures before an unchanged rerun;
existing Git maintenance scan race/audit-clock flake remain outside scope. Results
from slice 10 are context, not passing qualification for this slice.

Review final diff/movement, recheck frozen hashes, update this plan with actual
results/limits, commit/push verified increments and confirm remote identity/clean tree.

### Success criteria

Automated:
- [x] All 56 affected suites pass with SQLite and no new skips.
- [x] Full uncached pipeline passes under the documented qualification environment.
- [x] Scoped lint/whitespace, new-test semantic diagnostics, movement and hashes pass.
- [x] Completed plan/proof records actual results, limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public baseline pins both manager paths; real file SQLite proves durable intermediate
and final effects. Existing repository/event/council/advisory suites protect consumers.
Mocked engine/container/provider seams prove local contracts, not external availability.

The helper stays synchronous with the same writes/reads and no extra await. No
performance gain, new atomicity, crash recovery, fencing or idempotency is claimed.
No schema/API/dependency migration. Revert new module and manager wiring together.
Main integration, PR creation and deployment remain separate work.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-publication.md.
Predecessor: 2026-10-18-pod-manager-validation-evidence.md (complete).
Sources: pod-manager.ts:13612–13645 and :14708–14740; validation-repository.ts;
event-bus.ts; event-repository.ts and their existing tests.

The user explicitly approved this concrete plan and all three phases together.
All three approved phases are complete. No manual acceptance remains.
Integration, PR creation and deployment remain separate work.

## Phase 1 evidence

26 new public cases and 22 selected existing cases pass against unchanged product:
48 passed, 976 name-filtered. Both entry paths cover usage priority/fallback/zero,
state visible in real synchronous completion subscribers, optional history capture,
late insert lookup, terminal status changes in subscribers, and five failure stages
with preserved prior result/usage/history effects and original caller handling.
Selected evidence/council/advisory cases preserve returned-history consumers.

All 1,965 baseline package/script and six root control identities are recorded.
Only the planned public test file changed. Assertions are frozen byte-for-byte.
Actual Node 22.23.3 opens SQLite 3.49.2; pnpm 9.15.4. Baseline scoped Biome and
supplemental semantic checks pass cleanly. All new cases passed on their first run;
no baseline assertion correction was required. Raw commands/results are retained
under ignored .autopod-data/validation-publication/.

## Phase 2 evidence

All 48 selected public checks pass with the frozen assertions byte-identical.
33 direct cases exercise the actual factory using real migrated file-backed SQLite,
pod/validation/event repositories and event bus. Close/reopen plus integrity and
foreign-key checks verify final and intermediate durable effects. SQL triggers
fail result updates, usage updates, history inserts and event inserts; AFTER triggers
on usage/history prove their local rollback while earlier pod writes remain.

Direct observations pin synchronous return, native timestamp timing, exact returned
record/result identity, original argument forwarding, usage priority and optional
field shape, zero usage writes, current-state reads, retained references/late method
lookup, repeated-attempt sequence/cycle, and subscriber inspection/mutation/isolation.
Controlled read/insert/emit errors preserve identity and preceding effects.

The explicit 56-suite affected set passes: 1,950 tests, zero skips. Daemon/dependency
ESM and supported declaration builds pass. Four-file scoped Biome and supplemental
semantic checks of both new test boundaries are clean. Parsed TypeScript proof
verifies the ordinary body unchanged, original manual equivalence after two local
renames, two synchronous delegations and complete remaining manager. The new module
is 65 lines; manager is 17,343 lines, 56 fewer. All 1,963 other baseline package/script
paths are unchanged. The final 1,967-file and six-root-control manifests are frozen.

Initial direct assertions passed 29/32 cases. Three persisted-event expectations
incorrectly required explicit undefined-valued keys, which JSON omits. Corrected
assertions compare the entire persisted pod/history/event result to its exact JSON
serialized shape; no fields beyond JSON serialization are ignored. Added the zero
usage write-count check before final freeze. Raw initial output/exit and final
passing output are retained. No product correction followed the exact extraction.

## Phase 3: final qualification

Verdict: PROVEN for the approved local compatibility extraction under the documented
qualification environment. All phases are complete; no manual acceptance remains.

| Claim/check | Observed final evidence | Result |
|---|---|---|
| Public compatibility | 48 selected before/after checks, 26 new; assertions byte-identical | Passed |
| Synchronous publication and persistence | 33 direct cases; actual file SQLite, repositories/event bus, SQL failures and reopen/integrity checks | Passed |
| Surrounding orchestration | 56 affected suites; 1,950 passed; zero skipped | Passed |
| Full uncached pipeline | Frozen install, lint, build, supported declaration typecheck, tests, audit and secret scan | Passed under documented environment |
| Vitest | 7,829 passed across 498 passing files; 10 existing gated skips | Passed with existing skips |
| Standalone Node scripts | 35 passed; zero failed/skipped | Passed |
| Source integrity | 1,967 package/script hashes plus 6 root control hashes unchanged through qualification | Passed |
| Exact movement and scope | Original ordinary body, two equivalent original blocks and two synchronous delegations; two product/two test paths | Passed |
| Scoped quality | Biome/whitespace clean; zero semantic diagnostics in both new test boundaries | Passed |

Tested implementation: ae70965276686c4a7074d97bb10204262efd9a3a. A following documentation-only commit
records qualification without changing qualified source/test bytes. Final remote
identity and clean-worktree confirmation are recorded privately after push.

Actual full command using the existing task-local npx launcher:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Actual Node 22.23.3 opens SQLite 3.49.2; pnpm 9.15.4. Build/typecheck/test groups
ran uncached. Frozen install succeeded without fallback or lockfile mutation.
Root lint retained 82 existing warnings while processing the large manager test
with only the approved --files-max-size=2097152 addition. Scoped files are clean;
no rule/file selection was disabled and no repository/global configuration changed.
The inherited maintenance.auto=false is process-only. The default-environment Git
maintenance metadata-scan race and audit-clock flake remain outside this extraction.
The 10 existing gated skips remain; no new case was skipped. No source/test change
was made during final qualification. Initial failures, corrections and raw exits
are retained with the final passing results.

The manager is 17,343 lines, 56 fewer. validation-publication.ts is 65 lines. Parsed
TypeScript comparison proves the exact moved ordinary body and complete remaining
manager; the original manual body is equivalent after only two local-name renames.
Both delegations bind the original validationRecord synchronously. Early sandbox
unavailability, council/advisory consumers, ownership and terminal handling remain
unchanged under the exact recipe. All 1,963 other baseline package/script paths
are unchanged. No product correction followed the original extraction.

Evidence is retained under ignored .autopod-data/validation-publication/: proof.json,
movement.json, baseline/frozen/root-control manifests, frozen public assertions,
before-source and expected-recipe copies, original two blocks, actual runtime and
qualification command, before/after/build/affected/full/scoped-Biome/type logs and
exits, the initial undefined-JSON expectation failure, and pushed identities.

Real SQLite files, repositories and event bus substantiate saved state and partial
effects after controlled SQL failure. Local manager tests substantiate both caller
paths and retained history consumers. Controlled engine/container/provider seams
do not establish live external availability, new atomicity, outbox delivery,
fencing, crash recovery, cross-process safety or idempotency.

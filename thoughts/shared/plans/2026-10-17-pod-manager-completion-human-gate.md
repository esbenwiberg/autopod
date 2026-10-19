# Slice 4: completion human gate extraction

Status: COMPLETE — all three approved phases implemented and locally verified.
Baseline: 52e19de13907deec1737fb56829f833a5fcb2678.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract the two completion branches that hold a settled worker for an unanswered
question or uncollected guidance. This begins the completion/decisions workstream
after the three workspace slices. Use the accepted characterize → extract → qualify
structure. Approval of this concrete plan authorizes all three phases together,
with no intermediate manual gate. The user explicitly approved all three phases.

## Current state analysis

See ../research/2026-10-17-pod-manager-completion-human-gate.md.
At baseline, pods/pod-manager.ts:11106–11159 contains the two branches, between
native Goal/status admission and output dispatch. They differ deliberately:
questions remain pending; guidance parks the current owning worker as failed.
The guidance branch rechecks ownership after capture; the question branch does
not. Settlement is outside the guidance transaction. Optional legacy repositories
can lack journal or transaction support. Preserve all these facts.

## Desired end state

A small typed factory owns these two branches. handleCompletion retains its
existing public signature, native Goal/status admission, artifact/source routing,
coalescing map, validation, delivery and cleanup. The new operation returns a
promise when it holds completion and undefined when the caller should continue
synchronously, preserving the current no-await fast path.

Exactly two product files change: existing pods/pod-manager.ts and new
pods/completion-human-gate.ts. Tests change only pods/pod-manager.test.ts and new
pods/completion-human-gate.test.ts. All paths below use packages/daemon/src/.

## Scope boundaries

No new lifecycle states, decision rules, reply/acknowledgment protocol, generation
or cycle fencing, retries, locks, source guarantees, APIs, schema, profile,
dependencies or output selection. Existing journal, nudge repository, delivery,
unit-of-work, preservation, artifact finalizer and shared transition/ownership
implementations remain unchanged. No real pod, deployment, PR or main merge.

## Implementation approach

Create createCompletionHumanGate returning:

    holdCompletionForHumanWork(pod: Pod): Promise<void> | undefined

Use seven narrow dependencies:

- podRepo: Pick<PodRepository, 'getOrThrow' | 'completionJournal' | 'atomically'>;
  retain optionality of journal and transaction support.
- nudgeRepo: Pick<NudgeRepository, 'hasPending'>.
- preservePodWorkspace(pod: Pod, reason: string): Promise<void>.
- ownsArtifactCompletion(pod: Pod, allowRemovedContainer?: boolean,
  allowQueuedGuidance?: boolean): boolean.
- transition(pod: Pod, to: 'failed', extraUpdates: { failureReason: string }): Pod.
- logger: Pick<Logger, 'error'>.
- emitActivityStatus(podId: string, message: string): void.

Import the existing atomicPodChange directly. Use existing domain types; no any
or manager dependency. Compose immediately after createWorkspacePreservation,
passing existing manager functions. Those shared function declarations stay put.

Move each original branch body into a private async helper, holdForPendingQuestion
and holdForQueuedGuidance, retaining its void early returns. The synchronous public
operation checks the two original conditions in order and returns the selected
helper promise, or undefined if neither applies. Helpers derive podId from pod.id.
In the manager, replace exactly those branches with:

    const heldCompletion = holdCompletionForHumanWork(pod);
    if (heldCompletion) {
      await heldCompletion;
      return;
    }

Allow only imports, typed factory wrapper, composition, local ID binding, branch
wrapper/dispatch and formatting. Compare final source against that exact movement
recipe. Keep journal optional access dynamic at each operation. Do not declare the
public operation async or await an empty result before output dispatch.

Compatibility details:

1. awaiting_input OR pendingEscalation selects the question branch first, including
   when guidance also exists. Existing source proof skips only question capture.
2. Both containerId and worktreePath are required for capture. Missing inputs do
   not invent proof or release resources. Optional journal absence remains valid.
3. Exact preservation reasons, logs, activity and failure-reason text remain.
   Preserve caught versus propagated errors, including non-Error throws.
4. Guidance always retains its queue. Do not read, acknowledge or consume it.
5. Guidance calls ownsArtifactCompletion(pod, false, true) after capture, then
   reloads the pod. Superseded guidance resolves its held promise without the later
   mark/transition.
   Do not add a matching fence to the question branch during this extraction.
6. Guidance mark and failed transition remain within the existing transaction;
   activity remains after it. Earlier settlement and workspace operations remain
   outside. Do not add atomicity or rollback claims covering those earlier effects.
7. Neither branch cleans up containers/worktrees or enters validation/delivery.
   When neither branch applies, original output dispatch remains the next action.

## Phase 1: characterize public completion behavior

### Changes required

Only pods/pod-manager.test.ts. Add 'completion human gate compatibility' cases
using its existing real SQLite context and infrastructure seams. Invoke the public
manager, without importing the future factory or adding production test seams.
Keep existing end-to-end tests as complementary coverage rather than duplicating
transport/acknowledgment implementations in new fixtures.

Cover:

- Question via awaiting_input and via pendingEscalation on running; question wins
  over queued guidance. Decision identity, question, queue and resources survive;
  no validation, delivery or cleanup follows.
- Successful preservation, existing source proof, repeated completion and missing
  container/worktree independently. Preserve first settlement identity/time and
  existing repeated activity behavior. Optional journal absence still works.
- Capture failure for Error and non-Error values, later retry, and question mark
  failure caught by its existing catch. Settlement failure propagates.
- Guidance capture success/failure/missing inputs, exact reason and retained queue.
  Existing source proof does not skip this branch's capture. Include read without
  acknowledgment using the real queue/receipt infrastructure where applicable;
  existing end-to-end cases remain the transport oracle.
- Held capture followed by a generation change, container replacement, status
  change or newly pending question: no subsequent failed transition/mark/activity
  from the old guidance invocation. Account for settlement that already happened.
- Transaction failure injected at podRepo.update for the failed transition:
  journal mark rolls back, earlier settlement remains, guidance stays pending,
  and no status publication or final guidance activity escapes. Capture complete
  state before/after rather than requiring nonexistent rollback of source capture.
- No pending human work continues the existing artifact and source routes.
  Manager's native Goal/status checks still run before this gate. Overlapping
  artifact completions retain the existing coalescing outcome and single finalizer.

Close every DB, restore spies/timers, release/join held work, and remove temporary
resources in finally. Freeze product/test identities and keep raw baseline logs
under .autopod-data/completion-human-gate/ (ignored).

### Success criteria

Automated:
- [x] New public cases pass against unchanged baseline product source.
- [x] Existing reply/guidance/journal end-to-end cases pass with SQLite enabled.
- [x] Before-source/test hashes and actual command results are retained.

Manual: None required for this headless compatibility extraction.

## Phase 2: extract and prove the persistence boundary

### Changes required

Apply the two-file movement above; keep Phase 1 assertions byte-identical.
Add completion-human-gate.test.ts with real pod/nudge repositories and production
journal/unit-of-work against private temporary SQLite files. Use the existing
createTestDb migrations and serialized seed if needed, then operate on an actual
file-backed database. Close and reopen before inspecting durable results.

Direct factory cases establish:

- Question handling retains decision ID/text, pending status, settlement and
  successful source marker across close/reopen, with exact queue contents intact.
- Guidance handling retains message identity/order/content and unconsumed state,
  persists the existing failed reason and awaiting_human phase, and records source
  proof only after the preservation callback succeeds. No answer or acknowledgment
  is invented. Existing proof is not erased by a false mark.
- A held or rejected preservation callback cannot create premature source proof.
  These controlled callbacks establish orchestration/acknowledgment order; physical
  source copying/checkpoint proof remains in the unchanged preservation suites.
- A real transaction fault rolls back the guidance mark/status write and queued
  afterCommit effects while retaining the earlier settlement and pending messages.
  Reopen to inspect persisted state; run integrity_check and foreign_key_check.
- The post-await ownership predicate is invoked with false,true; loss resolves the
  held operation without the later mutation. With neither condition pending, the
  operation returns undefined synchronously, creating no promise for this fast path.
- Typed legacy dependency wrappers without journal/atomically retain fallback
  behavior; do not attribute production rollback to a nontransactional wrapper.

Compare both product files to the planned construction, including unchanged
remaining manager text. Confirm shared ownership/transition, completion journal,
queue/delivery, preservation and output dispatch implementations are untouched.

### Success criteria

Automated:
- [x] Identical public characterization passes after movement.
- [x] Direct file-backed persistence, ordering and real rollback tests pass.
- [x] Movement receipt proves only the planned boundary changed.
- [x] Only two approved product paths differ from baseline.

Manual: None required. Live Docker/Azure qualification is outside this boundary.

## Phase 3: qualify final source and record evidence

Use the established ignored Node 22.23.3 / pnpm 9.15.4 npx launcher from preceding
slices. Confirm the actual child runtime and open SQLite. Keep this slice's proof
under .autopod-data/completion-human-gate/, preserving older slice evidence.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'completion human gate compatibility'

Run the full 18-suite affected set from slice 3 plus five suites: the new gate,
main e2e, attached replies, guidance delivery and unit-of-work (23 suites total):

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/completion-human-gate.test.ts src/e2e.test.ts src/pods/attached-reply-delivery.test.ts src/pods/operator-guidance-delivery.test.ts src/db/unit-of-work.test.ts src/pods/validation-workspace.test.ts src/worktrees/graft-reconcile.test.ts src/worktrees/sandbox-reconcile.test.ts src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts
    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/completion-human-gate.ts packages/daemon/src/pods/completion-human-gate.test.ts
    git diff --check
    TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Freeze final package/test/script identities before qualification; compare after.
Record exact commands, results, counts, skipped cases and limitations. Review the
final diff, commit/push verified increments per repository instructions and confirm
remote identity. Update this plan with observed results. Unrun checks stay pending.

### Success criteria

Automated:
- [x] All affected suites pass with SQLite included and no new skipped cases.
- [x] Full uncached install/lint/build/typecheck/test/audit/secret pipeline passes.
- [x] Runtime/source identities and baseline/final evidence are recorded.
- [x] Scoped lint, whitespace and exact movement review pass.
- [x] Verified commits are pushed and remote commit identity matches.

Manual: None required. Approval covers all three automated phases together.

## Testing strategy and limitations

Public characterization protects composition, ordering and downstream admission.
Direct real SQLite cases protect the moved persistence boundary, retained questions
and messages, and current transaction behavior. Existing transport, receipt and
preservation tests protect collaborators. This establishes local compatibility;
it does not establish crash recovery, cross-process serialization, live provider
behavior or new lifecycle/cycle guarantees.

## Performance, migration and rollback

One factory call replaces two inline branches; no new I/O/retries. The empty path
returns synchronously, preserving the existing no-await dispatch/coalescing window.
Characterize overlapping artifact completions as well as ordinary routing. No
schema, dependency, API or configuration migration. Revert manager wiring and the new module together.
Integration with concurrent main work remains separate.

## References and next action

- Research: ../research/2026-10-17-pod-manager-completion-human-gate.md.
- Predecessor: 2026-10-17-pod-manager-validation-workspace.md (complete).
- Relevant implementations: completion-journal.ts, nudge-repository.ts,
  operator-guidance-delivery.ts, ../db/unit-of-work.ts and artifact-finalizer.ts.

All three approved phases are complete. No manual acceptance remains for this
headless compatibility boundary. Integration, PR creation and deployment remain
separate requested work; none was performed.

## Phase 1 evidence

At unchanged product baseline 52e19de1 (documentation HEAD bafeee2e), 34 new
public cases plus three existing source/artifact compatibility cases passed: 37
passed, 761 name-filtered. Six existing reply, guidance, journal, lifecycle and
unit-of-work suites passed 68 cases, with zero skipped. Actual Node 22.23.3 opened
SQLite; pnpm is 9.15.4. Scoped Biome and whitespace checks passed. Baseline product
and characterization hashes/copies and raw logs are retained under the ignored
.autopod-data/completion-human-gate/ directory.

Initial fixture runs omitted the required ACR-qualified sandbox warm-image tag.
Four stale-owner assertions then overreached by treating preservation activity
timestamps as lifecycle mutation. The final assertions compare all other fields
exactly, explicitly retain the activity update, and still forbid subsequent journal
marks, failed transitions and final guidance activity. These corrections happened
before any product movement; failed logs remain retained. An extra broad tsc
--noEmit diagnostic includes existing unrelated test/type errors and is not the
repository typecheck command. Its new optional-callback type error was corrected;
the supported build/typecheck pipeline remains a required Phase 3 gate.

## Phase 2 evidence

createCompletionHumanGate is a 94-line module. Two private helpers retain the
original branch bodies and returns; its public dispatch remains synchronous when
no human work is pending. The manager is 34 lines smaller (18,040 to 18,006),
retaining native Goal/status admission, shared ownership/transition functions,
artifact coalescing and downstream source/validation/delivery behavior.

The same 37 selected public cases passed after extraction (761 name-filtered),
with the characterization file byte-identical. Fourteen direct cases passed
against real temporary SQLite files, with close/reopen, integrity/foreign-key
checks, durable question and queue retention, source-marker ordering, real
transaction rollback, current ownership and optional legacy repositories.
Controlled preserver callbacks establish orchestration; physical source handling
is covered by the unchanged preservation suites.

All 23 affected suites passed: 1,004 cases, zero skipped. Dependency/daemon build,
four-file Biome and git diff --check passed. movement.json compares parsed
TypeScript tokens to the exact construction recipe (allowing import order and
formatting/trailing commas) and confirms all 1,949 other baseline package/script
paths unchanged. The comparator was corrected to parse template literals rather
than treating their contents as standalone scanner tokens; no product adjustment
was needed. Final qualification freezes 1,953 package/script identities. Logs and
receipts are retained under .autopod-data/completion-human-gate/.

## Final verification: Phase 3

Verdict: PROVEN for the approved local compatibility extraction. All required
automated work is complete; no manual gate remains.

| Claim/check | Observed evidence | Result |
|---|---|---|
| Caller compatibility | Byte-identical characterization: 37 selected cases before/after, 761 name-filtered | Passed |
| Durable human work and capture ordering | 14 direct real-file SQLite cases, actual close/reopen and integrity checks | Passed |
| Transaction behavior | Real rollback retains earlier settlement/queue and discards mark/status writes and queued publication | Passed |
| Surrounding orchestration | 23 affected suites, 1,004 passed, zero skipped | Passed |
| Full uncached pipeline | Frozen install, lint, build, repository typecheck, tests, audit and secret scan | Passed |
| Repository Vitest | 7,336 passed across 491 passing files; 10 existing skipped cases | Passed with existing skips |
| Standalone Node scripts | 35 passed, zero failed/skipped | Passed |
| Source identity | All 1,953 frozen package/script files unchanged through qualification | Passed |
| Scoped lint and whitespace | Four TypeScript files clean; git diff --check clean | Passed |

Actual full command: TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh,
using the established task-local npx launcher. Node 22.23.3 opened SQLite; pnpm
reports 9.15.4. Build/typecheck/test Turbo groups ran uncached. Frozen install
succeeded without fallback. Repository Biome retained 82 existing warnings;
scoped Biome had no warnings. Audit found no known vulnerabilities.

The 10 existing skipped cases retain the Docker/platform/live-model gates from
the preceding slice; no new test was skipped. All SQLite-backed tests were
explicitly enabled. An extra broad tsc --noEmit diagnostic during characterization
reported existing unrelated test/type errors and one new optional-callback type
annotation, corrected before the baseline freeze. That supplemental diagnostic
is retained as failed; the required repository build and typecheck both passed.

Validated implementation: ce588dcbf672be1dbda2d746fc03c8fee44f9ab7. A following documentation-only commit records
these results without changing tested product sources. Parsed source comparison
confirms the exact two-branch movement and unchanged remaining manager after
planned imports/wiring/formatting. No existing journal, queue, acknowledgment,
transaction, preservation, artifact or validation implementation was edited.

Evidence: .autopod-data/completion-human-gate/proof.json, movement.json,
baseline/final source manifests, frozen characterization and before-source copies,
actual before/after/persistence/affected/build/scoped-Biome/full-validation logs,
and retained failed fixture/diagnostic logs. Final documentation/remote identity
and clean-worktree confirmation are added to private proof after the final push.

Limits: persistence/ordering are tested against real local SQLite, with controlled
preserver callbacks. Physical source handling is covered by the unchanged prior
slice suites. This is not live Docker/Azure/provider qualification, deployment,
PR/main integration, crash recovery or a new serialization/fencing guarantee.

# Slice 7: validation attempt start extraction

Status: READY FOR REVIEW — implementation has not started.
Baseline: 5385bfd6f37e17c8e8ef03ae49b2f7a6f990e142.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Begin the validation-orchestration workstream by extracting the ordinary attempt-start
sequence in triggerValidation. Keep the established characterize → extract → qualify
structure. Approval of this concrete plan covers all three phases together, without
an intermediate manual gate. Implementation awaits explicit approval of this plan.
Commit and push verified increments per the user's repository instructions.

## Current state analysis

Research: ../research/2026-10-17-pod-manager-validation-attempt-start.md.
At the baseline, pods/pod-manager.ts:13560–13597 contains a cohesive sequence:
guidance guard → awaited security scan → optional terminal counter reset → validating
transition → wake/normal attempt accounting → start event → suite/rework activity.
The following try block begins container and engine work. Earlier checks and the
forced-Rework branch can exit before reaching this sequence. Manual revalidation has
different accounting and ordering; it is not interchangeable with this start path.

## Desired end state and scope

createValidationAttemptStart owns exactly this contiguous ordinary-start region.
The manager receives its existing s1, attempt and validationSuite values and continues
through the unchanged try/catch, workspace/configuration, execution and result paths.
Public method signatures remain identical. Exactly two product files change:

- New pods/validation-attempt-start.ts.
- pods/pod-manager.ts: import, factory composition and contiguous delegation only.

Tests change only pods/pod-manager.test.ts and new pods/validation-attempt-start.test.ts.
Keep termination/native Goal guards, compromised-worktree checks, bound-profile
resolution, lifecycle captures, update-intent closures, forced Rework, manual
revalidation, source preparation, retry/cancellation/result policies and shared
helpers in place. No new admission predicate, lifecycle state, transaction, fencing,
deduplication, schema, API, profile field, dependency, provider or concurrency policy.
No real pod/provider call, deployment, PR, main merge or unrelated maintenance-race fix.

## Implementation approach

Create a typed factory with seven narrow existing dependencies:

- assertGuidanceCollected(podId: string): void.
- runPushCheckpointScan(pod: Pod, profile: PodExecutionSettings): Promise<void>.
- podRepo: Pick<PodRepository, 'update'>.
- transition(pod: Pod, to: 'validating'): Pod.
- eventBus: Pick<EventBus, 'emit'>.
- getPodValidationSuite(pod: Pod): NonNullable<PodOptions['validationSuite']>.
- emitActivityStatus(podId: string, message: string): void.

Return this operation and result shape:

    startValidationAttempt(
      pod: Pod,
      profile: PodExecutionSettings,
      fromTerminal: boolean,
    ): Promise<ValidationAttemptStart>

    interface ValidationAttemptStart {
      s1: Pod;
      attempt: number;
      validationSuite: NonNullable<PodOptions['validationSuite']>;
    }

Derive local podId from pod.id. Move the region from assertGuidanceCollected through
the final Starting ... validation activity without changing any body expression,
receiver, log/message, await or order. Add only the final object return. s1 remains
the actual transition result, not a clone or a post-counter reload. The factory
captures dependencies without I/O. Compose after createCompletionDecision.

Replace only the contiguous manager region with:

    const { s1, attempt, validationSuite } =
      await startValidationAttempt(pod, profile, fromTerminal);

Keep this call outside the following try. Do not move initial guards, forced Rework,
dynamic this callbacks, profile resolution or the downstream container probe into
the module. No new status/ownership reads or checks are added around the awaited scan.
Allow only imports/composition, typed wrapper, local podId, final return, delegation
and formatting. Compare the complete remaining manager against that exact recipe.

## Compatibility requirements

1. Uncollected guidance rejects before scanning, writes or start events. Keep the
   existing guard's scope; do not add a pending-question policy here.
2. Preserve the actual shared scan helper: no scanner/worktree is a no-op; a block
   AutopodError propagates; ordinary scan errors log and continue; escalation does
   not newly block. This extraction does not weaken or strengthen scan policy.
3. Terminal reset precedes transition. Transition precedes attempt/wake update.
   Wake retains the transition-result counter and clears only the wake flag;
   normal/restart increments. Terminal+wake retains the reset zero. Preserve all
   resolved suite choices and the exact optional rework label/activity.
4. The start event uses the selected attempt after the write, and precedes suite
   activity. Event publication and activity stay separate effects. Retain timestamps.
5. The returned s1 retains its pre-counter-update fields. Actual persisted counters
   can differ from that snapshot. The manager uses the returned attempt/suite and
   that exact s1 for its existing downstream configuration and messages.
6. Preserve error identity and partial effects: rejection remains outside the later
   engine try/catch; do not roll back, catch/reclassify, clean resources, enqueue,
   or emit an engine result for an entry failure that currently propagates.
7. Preserve reentrant/shared-helper behavior and captured pre-scan inputs. No new
   atomicity, lifecycle fencing, crash recovery or cross-process guarantee is implied.
   Manual revalidation/forced Rework remain distinct, with no shared-policy rewrite.

## Phase 1: characterize public attempt entry

Only change pods/pod-manager.test.ts. Add a validation attempt start compatibility
group using public triggerValidation and the existing real SQLite manager context.
Use infrastructure seams; do not import the future module or expose product hooks.
Hold the existing first container start/status operation after admission to inspect
entry state/events before downstream engine effects. Release and join held work in
finally. Reuse adequate existing wake/Rework/guidance/security tests.

Cover these observable outcomes:

- Running normal entry from counters zero and nonzero; terminal reset from failed,
  review_required, killed and validated when the existing branch reaches validation.
  Choose options/resources deliberately so a forced reprovision branch is not
  mistaken for ordinary entry. Check counter values at admission and engine input.
- Wake from running retains its counter and clears its marker; next entry increments.
  Restart increments and preserves its marker at entry. Terminal+wake starts at zero.
- Each explicit suite plus absent-suite validate:false/full fallbacks; explicit full
  with validate:false retains full. Pin start-event attempt and exact activity,
  including reworkCount zero/nonzero and maxValidationAttempts.
- Pending guidance blocks before scan/counter/status/events/container work. A held
  scan produces no entry effects until released. Scan pass/warn/escalate proceed;
  block propagates the existing code/status; ordinary scanner failure continues.
  Missing scanner/worktree retains the no-op scan behavior.
- Assert ordering of actual persisted status, counter/wake write, validation_started,
  activity and container/engine admission. Check event subscriber exceptions retain
  the event bus's existing behavior; distinguish them from publication failures.
- Actual initial termination/native Goal/compromised-worktree guards and forced
  Rework bypass this ordinary start; existing manual revalidation keeps its own
  attempt-one/reset-before-scan path and different activity.
- Controlled write/transition/start-event failures propagate outside the engine
  handler, preserving preceding effects and preventing subsequent admission. Avoid
  asserting rollback or additional ownership protection absent from the baseline.

Freeze product and characterization identities and raw results under ignored
.autopod-data/validation-attempt-start/. Close all DBs, restore spies/environment/
timers and clean private fixtures. Preserve earlier slices' evidence.

### Success criteria

Automated:
- [ ] New public cases pass against unchanged baseline product source.
- [ ] Relevant existing wake, Rework, guidance, security and validation cases pass.
- [ ] Frozen source/test identities, runtime and raw before results are recorded.

Manual: None required for this headless compatibility boundary.

## Phase 2: extract and prove persisted start effects

Apply only the two-file product move. Keep Phase 1 assertions byte-identical.
Add validation-attempt-start.test.ts with actual private file-backed SQLite using
the migrated schema and real pod/event repositories where persistence is claimed.
Use a test transition adapter with real validateTransition/repository writes;
public tests retain responsibility for the manager's actual transition helper.
Control scan/guard/activity callbacks without claiming to prove live scanner behavior.

Direct evidence:

- Verify normal, terminal, wake, terminal+wake and restart accounting across actual
  close/reopen; run integrity_check/foreign_key_check. Verify status and event data.
- Return a distinguishable transition result and verify result.s1 is exactly that
  object, with its original counter/marker values, while the DB reflects the later
  attempt write or wake clear. Suite/activity use that same s1 snapshot.
- Hold scan; no reset/transition/counter/start event occurs before release. Return
  values, dependency arguments and exact order match the original sequence.
- Guard/scan/reset/transition/counter-write/start-event/suite/activity failures keep
  error identity, preceding persisted effects and absence of later calls. Separate
  controlled failures from actual event-bus subscriber exception semantics.
- Factory construction has no side effects; suite choices and rework labels match
  the public behavior. No fabricated in-memory state counts as SQLite persistence.

Compare parsed TypeScript AST tokens for moved region and whole remaining manager
against the exact recipe. No shared helper implementation or other caller changes.

### Success criteria

Automated:
- [ ] Byte-identical public characterization passes after extraction.
- [ ] Real SQLite persistence, returned snapshot, ordering and failure cases pass.
- [ ] Exact movement receipt and unchanged shared helpers are recorded.
- [ ] Only two approved product paths and two test paths differ from baseline.

Manual: None required. No live provider/container qualification is claimed.

## Phase 3: qualify frozen final source

Use the established task-local npx launcher: Node 22.23.3 and pnpm 9.15.4. Confirm
actual child runtime and opened SQLite. Freeze final package/test/script hashes;
compare after qualification. Keep raw commands, exit codes, counts/skips, corrections
and limitations in .autopod-data/validation-attempt-start/.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation attempt start compatibility|wake recovery — validationAttempts skip'

Run slice 6's 30 affected suites plus the new module, pod-bridge-validation,
validation-repository, scan-engine, scan-policy, scan-repository,
configuration/security-policy and task-retry-ledger (38 total):

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/completion-human-gate.test.ts src/e2e.test.ts src/pods/attached-reply-delivery.test.ts src/pods/operator-guidance-delivery.test.ts src/db/unit-of-work.test.ts src/pods/validation-workspace.test.ts src/worktrees/graft-reconcile.test.ts src/worktrees/sandbox-reconcile.test.ts src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts src/pods/completion-source.test.ts src/worktrees/local-worktree-manager.test.ts src/worktrees/local-worktree-manager.git.test.ts src/worktrees/auto-commit-message.test.ts src/pods/completion-decision.test.ts src/configuration/series-launches.test.ts src/pods/state-machine.test.ts src/pods/validation-attempt-start.test.ts src/pods/pod-bridge-validation.test.ts src/pods/validation-repository.test.ts src/security/scan-engine.test.ts src/security/scan-policy.test.ts src/security/scan-repository.test.ts src/configuration/security-policy.test.ts src/pods/task-retry-ledger.test.ts
    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-attempt-start.ts packages/daemon/src/pods/validation-attempt-start.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

The process-only Git setting is the documented slice 6 qualification adjustment:
it prevents the reproduced maintenance.lock race in unchanged managed-source test
fixtures. Do not modify global/repository Git configuration, suppress assertions,
skip the source-delivery suite, or claim the default-environment race is fixed.
Run the full pipeline uncached with successful frozen install and no fallback
lockfile mutation. Use the repository-supported build/declaration typecheck.
Record actual new results rather than copying prior counts. Review final diff,
commit/push verified increments and confirm final remote identity/clean worktree.

### Success criteria

Automated:
- [ ] All 38 affected suites pass with SQLite and no new skips.
- [ ] Full uncached install/lint/build/typecheck/test/audit/secret pipeline passes
  under the documented qualification environment.
- [ ] Scoped lint/whitespace, source hashes and exact movement review pass.
- [ ] Evidence records actual runtime/results/limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public characterization proves real manager composition and observable entry effects.
Direct tests prove persisted SQLite state/event outcomes and returned observations;
controlled callbacks prove the extracted call contract. Existing suites protect shared
scanner, guidance, transition and later validation behavior. No live provider or new
crash/concurrency guarantee is established.

No I/O, scan, command budget or retry is added. The manager awaits a typed result
after the same existing scan and start effects; no performance gain is claimed.
No schema/API/configuration/dependency migration. Revert module and manager wiring
together. Integrating concurrent main work remains separate requested work.

## References and next action

- Research: ../research/2026-10-17-pod-manager-validation-attempt-start.md.
- Predecessor: 2026-10-17-pod-manager-completion-decision.md (complete).
- Existing factories: completion-decision.ts and validation-workspace.ts.
- Shared entry helpers: assertGuidanceCollected, runPushCheckpointScan, transition,
  getPodValidationSuite, event-bus.ts and state-machine.ts.

Next action: explicit approval of this concrete plan, then characterize the unchanged
ordinary start path before extracting it. No unresolved questions remain.

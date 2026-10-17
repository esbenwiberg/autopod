# Slice 5: completion source preparation extraction

Status: IN PROGRESS — Phases 1 and 2 complete; full qualification pending.
Baseline: d804b1da21af7d26ccbc14e5484bc67a43d528e6.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract the source preparation portion of handleCompletion, following the accepted
characterize → extract → qualify structure. The user explicitly approved this
concrete plan. Approval covers all
three phases together, with no intermediate manual gate for this headless boundary.

## Current state analysis

See ../research/2026-10-17-pod-manager-completion-source.md.
References below use packages/daemon/src/ at baseline d804b1da.

pods/pod-manager.ts:11134–11347 coordinates handover, checkpoint/sync, recovery,
auto-commit and statistics. It has deliberate differences between sandbox proof
classification and local diff statistics, and between failed sync and failed push.
The next block reloads current state and makes completion/validation decisions.
Shared recovery, guard handling, parking and transition helpers serve other paths.

## Desired end state

createCompletionSource owns this contiguous preparation region. Its operation
returns preparation data when the manager should continue, or undefined after an
existing blocking return. Public PodManager methods keep their current signatures.

The manager keeps native Goal/status admission, human-work hold, artifact dispatch
and coalescing, successful proof/decision telemetry, the fresh pod/settings reads,
no-change/Rework/fork/schedule rules, cleanup, events/dependents and triggerValidation.
A preparation result is not validation success or a publication receipt.

Exactly two product files change: new pods/completion-source.ts and existing
pods/pod-manager.ts. Tests change only pods/pod-manager.test.ts and new
pods/completion-source.test.ts. Existing collaborators remain unchanged.

## Scope boundaries

Preserve workspace authority, the exact checkpoint flag checks, start-commit diff
scope, guard thresholds, recovery choices, exception classification, logging and
stored-stat fallback. No retry/fencing/locking policy, new lifecycle state, atomicity,
schema, API, profile, credential, dependency or output-selection changes. No real
pod, provider call, deployment, PR or main merge. Artifact and interactive completion
coordinators, resume observation, transfer/checkpoint/Git primitives stay unchanged.

## Implementation approach

Create a typed factory with this returned operation and result shape:

    prepareSourceForCompletion(pod: Pod):
      Promise<CompletionSourcePreparation | undefined>

    interface CompletionSourcePreparation {
      sandboxCheckpoint?: WorkspaceCheckpointResult;
      sandboxCanonicalOutcome?: 'changed' | 'unchanged' | 'unavailable';
      sandboxHostProof?: { head: string; tree: string };
    }

Keep the existing local variable names/types in the moved body. Preserve every
blocking return as undefined; add one final object return with those three fields.
Even a local pod without a worktree returns an object so the manager continues,
matching current behavior. The object contains observations, not a new authority.

Use 14 narrow dependencies, all existing collaborators:

- podRepo: Pick<PodRepository, 'getOrThrow' | 'update'>.
- getContainerManager(target: Pod['executionTarget']): ContainerManager.
- worktreeManager: Pick<WorktreeManager, 'classifyCanonicalDiff' |
  'commitPendingChangesWithGeneratedMessage' | 'getDiffStats'>.
- checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult>.
- syncSandboxSeriesHandover(podId: string): Promise<void>.
- syncWorkspaceBack(containerId: string, worktreePath: string, cm: ContainerManager,
  podId: string, executionTarget: Pod['executionTarget']): Promise<{ pushed: boolean }>.
- tryRecoverAfterWorkspaceSyncFailure(pod: Pod, err: unknown,
  phase: 'auto-commit'): Promise<boolean>.
- recoverWorktreeFromContainer(containerId: string, worktreePath: string,
  cm: ContainerManager, podId: string): Promise<boolean>.
- parkOnWorktreeSyncFailure(podId: string, reason: string): void.
- handleDeletionGuardError(podId: string, err: unknown): boolean.
- transition(pod: Pod, to: 'failed'): Pod.
- executionForPod(pod: Pod): PodExecutionSettings.
- emitActivityStatus(podId: string, message: string): void.
- logger: Pick<Logger, 'info' | 'warn' | 'error'>.

Import the existing shared DeletionGuardError constructor from local-worktree-manager;
do not create a duplicate error class. Keep manager imports still used elsewhere.
Compose after the existing workspace and human-gate factories. Dependencies are
captured without I/O; shared function declarations remain in the manager.

Replace only the contiguous source-preparation region with:

    const preparedSource = await prepareSourceForCompletion(pod);
    if (!preparedSource) return;
    const { sandboxCheckpoint, sandboxCanonicalOutcome, sandboxHostProof } = preparedSource;

This replacement follows artifact dispatch. It does not insert an await in the
artifact or empty human-gate path. Derive local podId from pod.id in the factory;
replace its two containerManagerFactory.get calls with getContainerManager. Allow
only those receiver adaptations, imports, wrapper/composition, final result return,
manager delegation and formatting. Compare against this exact movement recipe.

Compatibility details:

1. Series handover precedes source I/O. Preserve its rejection behavior.
2. Sandbox uses verified checkpoint/classification, with exactly the existing
   promoted/materialized/lineageVerified checks. Do not invent additional flags.
   Missing worktree/base/checkpoint and unavailable classification retain their
   distinct messages/codes/parking. Thrown checkpoint/classification errors propagate.
3. Local failed push still proceeds with maxDeletions=0. Failed sync plus failed
   recovery stops before commit/stats/validation. Successful recovery uses 100.
   Missing container skips sync and retains the current default threshold.
4. Guard recovery retries with 100, even after an initially strict zero threshold.
   Repeated guard failure stops; ordinary first/retry commit errors can continue.
   Recovery rejection propagates. The guard branch transitions only a freshly
   reloaded pod whose status is running; do not add ownership predicates.
5. Local diff uses the same base/default/start arguments. Its catch includes the
   second settings lookup and DB update, and preserves old statistics on failure.
   Sandbox stats update is outside that catch. Preserve this asymmetry.
6. All logs, activity, error identity, repository mutations and side-effect order
   remain. A stopped preparation does not select validation, delivery or cleanup.
   Existing source/index mutations before failure are not automatically rolled back.

## Phase 1: characterize current public preparation behavior

### Changes required

Only pods/pod-manager.test.ts. Add 'completion source compatibility' cases using
its existing real SQLite context and infrastructure seams. Run the public manager
against unchanged product source; no future-module imports or product test seams.
Use existing ACR-qualified sandbox warm-image fixtures. Reuse current cases where
already adequate, including slice 4's question/artifact admission coverage.

Cover these observable outcomes:

- Handover, checkpoint/sync, commit/classification, statistics and validation order.
  Check only preparation calls before downstream validation/publication windows.
- Successful local sync, false push (strict zero), successful/failed sync recovery,
  recovery rejection, and missing container/worktree. Assert guard arguments and
  whether commit, stats and validation were reached.
- First DeletionGuardError with/without usable container, recovery true/false/throw,
  retry success, retry guard and retry ordinary error. Verify exact 0/100 thresholds,
  compromised flag/current failed transition and retained resources. Ordinary
  initial commit errors retain logged-and-continue behavior.
- Sandbox changed and unchanged checkpoint classification; each required checkpoint
  flag false independently; missing base/worktree/container; unavailable classification
  codes; thrown checkpoint/classifier and sandbox stats-update errors. Verify start
  commit and checkpoint commit/tree arguments, retained resources and blocked work.
- Local diff baseBranch/defaultBranch/main and startCommitSha combinations, fresh
  stats persistence, getDiffStats rejection, second settings lookup failure and stats
  update failure retaining prior stored statistics. Distinguish these from sandbox
  failures. Initial settings lookup failure still propagates.
- Existing local no-change, no-change Rework, fork/schedule, validation-off and
  changed-sandbox blocking-validation behavior still follow preparation. Pin those
  outcomes without moving their policy into the new module. Human holds and artifact
  output still bypass source preparation; artifact overlap behavior is unchanged.

Close every DB, restore spies/environment/timers, clean private paths and release/
join held work in finally. Freeze product/test identities and retain raw logs under
.autopod-data/completion-source/; keep preceding slices' evidence intact.

### Success criteria

Automated:
- [x] New public cases pass against unchanged product source at the baseline.
- [x] Existing completion, human-gate, artifact, checkpoint and recovery cases pass.
- [x] Before-source/test hashes and actual results are recorded.

Manual: None required for this headless compatibility extraction.

## Phase 2: extract and prove actual Git/source outcomes

### Changes required

Apply the two-file move above. Keep Phase 1 assertions byte-identical. Add
completion-source.test.ts. Use real temporary repositories with private Git config,
explicit fixture identity and actual LocalWorktreeManager methods. Use real SQLite
pod repositories to inspect persisted statistics/current state; close/reopen where
persistence is claimed. Bind actual worktree methods to their instance.

Control only infrastructure boundaries. For generated commit messages, mock the
provider-client helper to return its existing no_credentials result; run the real
auto-commit heuristic, staging, guard, commit and diff methods. No network/provider
credential is needed. Use canonical private fixture paths and clean them in finally.

Direct module evidence:

- Local dirty source creates an actual commit, preserves expected file bytes,
  updates real stored stats using the original start commit, and returns the local
  preparation object. No fabricated commit or diff result counts as this proof.
- Actual strict-zero and normal-100 deletion thresholds refuse excessive deletions.
  Assert HEAD/tree and resulting working/index state accurately: current primitive
  resets the index before guard rejection, but does not restore missing work files.
  Do not assert or implement whole-workspace rollback.
- Controlled recovery restores actual private source files; the real retry commits
  the recovered source with threshold 100. Distinguish a controlled recovery callback
  from live container recovery; existing transfer suites qualify that collaborator.
- Sandbox classification receives actual base/head/tree from private Git repositories.
  Test changed, unchanged/net-zero, excluded-only pnpm-lock.yaml and mode-only cases,
  plus missing base and mismatched expected head/tree. Persisted stats and returned
  proof match actual Git objects; unavailable proof blocks continuation.
- Checkpoint callbacks supply captured identities from actual prepared host fixtures.
  They do not count as proof of live bundle transfer. Existing checkpoint suites
  retain responsibility for transport/promotion/materialization implementations.
- Error paths, blocked undefined returns and the valid empty local object preserve
  caller semantics. Ordinary commit/stat failure and propagated checkpoint/recovery/
  classifier failure stay distinct. Verify no source-success object is returned
  from a path that currently blocks completion.

Compare the whole remaining manager and both moved source blocks against the exact
recipe. Confirm shared constructor identity, retained logging/catch scopes, unchanged
successful decision telemetry and unchanged downstream manager policy.

### Success criteria

Automated:
- [x] Identical public characterization passes after extraction.
- [x] Direct actual Git commit/guard/classification and SQLite effects pass.
- [x] Movement receipt proves only the planned preparation boundary changed.
- [x] Exactly two approved product paths differ from baseline.

Manual: None required. No live Docker/Azure/provider qualification is claimed.

## Phase 3: qualify the final source and record evidence

Use the established task-local npx launcher: Node 22.23.3 and pnpm 9.15.4.
Confirm actual child runtime and an opened SQLite database. Store this slice's logs,
source manifests and proof under ignored .autopod-data/completion-source/.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'completion source compatibility'

Run slice 4's 23 affected suites plus the new module and three Git/commit suites
(27 suites total):

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/completion-human-gate.test.ts src/e2e.test.ts src/pods/attached-reply-delivery.test.ts src/pods/operator-guidance-delivery.test.ts src/db/unit-of-work.test.ts src/pods/validation-workspace.test.ts src/worktrees/graft-reconcile.test.ts src/worktrees/sandbox-reconcile.test.ts src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts src/pods/completion-source.test.ts src/worktrees/local-worktree-manager.test.ts src/worktrees/local-worktree-manager.git.test.ts src/worktrees/auto-commit-message.test.ts
    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/completion-source.ts packages/daemon/src/pods/completion-source.test.ts
    git diff --check
    TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Freeze final package/test/script identities before qualification; compare afterward.
Record exact commands, exit statuses, counts, skips, corrections and limitations.
Use the repository's supported build/typecheck pipeline rather than treating a
broad all-test tsc diagnostic as its acceptance command. Review final diff, commit/
push verified increments per repository instructions, and confirm remote identity.
Update this plan with observed evidence. Unrun or failed checks remain labeled.

### Success criteria

Automated:
- [x] All affected suites pass with SQLite included and no new skipped cases.
- [ ] Full uncached install/lint/build/typecheck/test/audit/secret pipeline passes.
- [ ] Runtime/source identities and before/after/material evidence are recorded.
- [ ] Scoped lint, whitespace and exact movement review pass.
- [ ] Verified commits are pushed and remote commit identity matches.

Manual: None required. Approval authorizes all three automated phases together.

## Testing strategy and limitations

Public tests protect composition, thresholds, error interpretation and downstream
admission. Complete-module tests use actual local Git and SQLite to substantiate
source commits/classification and persisted effects. Existing transfer/checkpoint
suites protect those unchanged algorithms. Controlled infrastructure and provider
helpers do not qualify live containers, Azure or model providers. No new crash
recovery, lifecycle fencing, atomicity or cross-process synchronization is established.

## Performance, migration and rollback

One factory replaces the contiguous inline region; preserve I/O ordering and
existing command budgets/retries. No performance improvement is claimed. Existing
artifact/human-gate fast paths remain before the new await. No schema, API,
configuration or dependency migration. Revert manager wiring and module together.
Integration with concurrent main work remains a separate requested action.

## References and next action

- Research: ../research/2026-10-17-pod-manager-completion-source.md.
- Predecessor: 2026-10-17-pod-manager-completion-human-gate.md (complete).
- Existing primitives: workspace-preservation.ts, workspace-transfer.ts,
  ../worktrees/local-worktree-manager.ts, auto-commit-message.ts and diff-utils.ts.

No unresolved design question remains. Next action: explicit approval of this
concrete plan, then characterize the unchanged manager before moving product code.

## Phase 1 evidence

At unchanged product baseline d804b1da (documentation HEAD c7097270), all 45 new
public source-preparation cases passed alongside 40 existing compatibility cases:
85 passed, 758 name-filtered. Coverage includes series handover success/read failure/
write failure, held handover ordering, exact checkpoint flags, local sync/push and
recovery, 0/100 guards, propagated/caught failures, statistics and downstream policy.
Both baseline runs passed on their first execution; the second added handover and
checkpoint-flag coverage before freezing the final characterization file. Actual
Node 22.23.3 opened SQLite; pnpm is 9.15.4. Baseline source/test identities, raw
command log and runtime evidence are under ignored .autopod-data/completion-source/.
No product code changed during characterization.

## Phase 2 evidence

createCompletionSource is a 291-line module. pod-manager is 195 lines smaller
(18,006 to 17,811). The contiguous preparation region retains its original body
with only two container lookup receiver adaptations, a local pod ID and the final
observation return. Manager admission, human/artifact routing, fresh reads, final
decision telemetry, completion/validation choices and shared helpers are unchanged.

The byte-identical public characterization passed after extraction: 85 selected
cases, 758 name-filtered. All 21 new material-boundary cases passed using real
private Git repositories and SQLite files: actual staging/heuristic commits,
0/100 guard rejection and index reset, controlled file restoration and real retry,
changed/unchanged/net-zero/excluded-only/mode-only canonical diffs, missing/mismatched
proof, persisted stats and distinct continuation/error behavior. SQLite close/reopen
checks include integrity and foreign-key checks. Provider client availability is
controlled as no_credentials; Git/staging/guard/commit/diff algorithms are real.

The initial direct run had ten fixture setup failures because it selected sandbox
execution after attaching a container. The fixture now seeds its execution target
before attachment, respecting the repository invariant. No product fix or assertion
relaxation was needed; the initial failed log is retained as such.

All 27 affected suites passed: 1,225 tests, zero skipped. Dependency/daemon build,
four-file scoped Biome and git diff --check passed. movement.json compares parsed
TypeScript against the exact recipe and confirms all 1,951 other baseline package/
script paths unchanged. All 1,955 final package/script identities are frozen for
qualification. Evidence is under ignored .autopod-data/completion-source/.

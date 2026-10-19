# Slice 8 research: validation input preparation

Date: 2026-10-17.
Baseline: 150d725c16fc823e125261f552ed37e75a365243.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Scope: describe the ordinary triggerValidation input-assembly region and its consumers.

## Current ownership

Seven extraction slices are complete. The latest module, validation-attempt-start.ts,
returns the transition snapshot s1, selected attempt and suite. The manager remains
17,714 lines. This is substantial remaining orchestration, not a nearly finished rewrite.
The original roadmap has five broad workstreams, not a fixed number of slices.

packages/daemon/src/pods/pod-manager.ts:13372 begins triggerValidation. It performs
termination/Goal/worktree guards, effective profile resolution and forced Rework.
At :13571 it awaits startValidationAttempt outside the following engine try/catch.
Inside that catch boundary it checks/restarts the container and prepares the workspace.
The preparation may park and return before input assembly (:13656–13661).

The contiguous :13663–13776 region assembles ordinary validation inputs:

1. Publish Computing diff activity. Choose startCommitSha and the PR base branch:
   pod.baseBranch, then profile.defaultBranch, then main, using nullish fallback.
2. Await validationEnvironmentForPod, then overlay buildValidationContextEnv. The
   context helper's reserved keys therefore override colliding build environment keys.
3. Read diff and commit log concurrently with Promise.all when a worktree exists;
   pass startCommitSha as the fourth argument. Without a worktree both are empty.
4. If available, read changed paths against the base branch, independent of the
   start-commit-scoped review diff. Otherwise parse paths from the diff. Apply the
   existing protected-operational-path scope assertion before loading review inputs.
5. Load the repository code-review skill. Resolve reviewer profile/credentials and
   await reviewer execution environment. These helpers retain their own behavior.
6. Read chronological previous validation and prior review batch, not attempt-1.
7. Flush queued human overrides. Merge by findingId, incoming values winning; write
   pod.validationOverrides only if the queue had entries. Flush and update are
   separate effects. A later failure does not currently restore the queue.
8. Build engine configuration, including defaults, seconds-to-milliseconds timeouts,
   provider/account/credentials/executor, task context, optional reviewer env,
   scoped versus legacy API-key behavior, suite, skip phases and prior review batch.

The body uses the original captured pod for most fields but s1 for skip phases.
It does not reload either object or add an ownership fence during preparation.
The containerId guard precedes this region, while the config reads pod.containerId
at construction time after awaits. Preserving that read timing matters.

## Shared helpers and effects

validationEnvironmentForPod (:1973) can refresh registry files and assert launch
capabilities. buildReviewerExecEnv (:5225) can refresh provider material. Neither is
a pure value lookup. getEffectiveReviewerConfig (:5327) handles selected account and
independent-reviewer routes. getReviewerExecutor (:5383) may resolve config again.
Do not consolidate or cache these calls as part of an extraction.

loadCodeReviewSkill (:1047) tries skills/code-review.md then .claude/skills/code-review.md;
file errors are swallowed. mergeOverrides (:1286) uses an insertion-ordered Map and
replaces by findingId. getPodValidationSkipPhases (:1859) uses the supplied snapshot.
assertProtectedOperationalPathsInScope (:5784) throws the existing 422 error when
protected paths lack explicit scope. All these helpers have other callers.

pending-override-repository.ts flush selects ordered rows and then deletes them;
there is no transaction joining flush to podRepo.update. validation-repository.ts
getLatest/getLatestReviewBatch provide chronology across reset display attempts.
The engine's public config type is interfaces/validation-engine.ts:ValidationEngineConfig.

## Consumers and failure boundary

After assembly (:13778), the manager creates its controller, claims validation,
runs infrastructure retries, checks ownership and cleans up its controller. Later
result logic uses validationConfig for retry-council and advisory runs, and uses
previousValidation to compare retry findings (:14021). No other assembly local is
needed outside this region.

The existing outer catch (:14687 onward) handles preparation errors, update intents,
superseded/retry conditions and failed status/container stopping. Moving assembly
must keep the awaited call inside this catch. No preparation-local catch exists.

Manual revalidateSession (:14735) has a different config body (:14916–15002): it does
not flush these pending overrides or return previousValidation, and differs in brief
and legacy-key fields. Similarity does not establish interchangeable policy.

## Existing evidence and next action

pod-manager.test.ts covers sandbox target (:14767), suite settings (:14962 onward),
diff context (:15094), chronological review cycles (:18131), protected operational
paths and inherited base changes (:21921, :21965), manual revalidation (:22764), and
reviewer dispatch/ownership cases. The manager test fixture uses real pod/history/
override/event SQLite repositories with mocked external infrastructure.

Slice 7 qualification passed 1,494 affected cases and 7,543 full Vitest plus 35 Node
cases, with 10 existing gated skips. These are predecessor results, not slice 8 proof.
Its full run used process-only maintenance.auto=false to avoid a reproduced Git
maintenance-lock race in unchanged source-delivery fixtures; that race remains unfixed.

No product/test files changed and no tests ran during this research. The companion
plan fixes the next boundary and tests. No product decision or external input is pending.

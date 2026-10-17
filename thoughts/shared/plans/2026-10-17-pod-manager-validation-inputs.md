# Slice 8: validation input preparation extraction

Status: IN PROGRESS — explicitly approved; Phase 1 complete.
Baseline: 150d725c16fc823e125261f552ed37e75a365243.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract the ordinary validation input-assembly sequence into validation-inputs.ts.
Give the engine one typed configuration and retain the prior chronological result
for the manager's retry decisions. Preserve all observable behavior.
Use the established characterize → extract → qualify structure. Approval covers
all three phases together, with no intermediate manual gate for this headless move.
The user explicitly approved this concrete plan. Commit and push
verified increments per the user's repository instructions.

## Current state analysis

Research: ../research/2026-10-17-pod-manager-validation-inputs.md.
At baseline, pods/pod-manager.ts:13663–13776 is a contiguous 114-line assembly block,
after container/workspace preparation and before validation ownership is claimed.
It gathers source context, enforces protected-path scope, resolves reviewer inputs,
reads chronological history, consumes queued overrides and constructs engine config.
Only validationConfig and previousValidation escape this region. The call remains
inside the existing outer try/catch. Manual revalidation has different inputs.

## Desired end state

Exactly two product files change:

- New packages/daemon/src/pods/validation-inputs.ts.
- packages/daemon/src/pods/pod-manager.ts: import, composition and delegation only.

Exactly two test paths change:

- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-inputs.test.ts: direct boundary proof.

Public manager signatures and downstream engine/council/advisory behavior stay the
same. The manager keeps container readiness, workspace preparation, ownership,
retries, cancellation, screenshots, results, delivery and correction decisions.
Shared helper implementations and every other caller remain unchanged.

## Implementation approach

Create createValidationInputs with 14 narrow existing collaborators:

1. logger: Logger.
2. worktreeManager: Pick<WorktreeManager, 'getDiff' | 'getCommitLog' | 'getChangedPathsAgainstBase'>.
3. podRepo: Pick<PodRepository, 'update'>.
4. validationRepo?: Pick<ValidationRepository, 'getLatest' | 'getLatestReviewBatch'>.
5. overrideSource: { pendingOverrideRepo?: Pick<PendingOverrideRepository, 'flush'> }.
6. validationEnvironmentForPod(pod: Pod, profile: PodExecutionSettings): Promise<Record<string, string> | undefined>.
7. assertProtectedOperationalPathsInScope(pod: Pod, paths: string[]): void.
8. loadCodeReviewSkill(worktreePath: string, log?: Logger): Promise<string | undefined>.
9. getEffectiveReviewerConfig(pod: Pod): { profile: PodExecutionSettings; credentials: ProviderCredentials | null }.
10. buildReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>.
11. mergeOverrides(existing: ValidationOverride[], incoming: ValidationOverride[]): ValidationOverride[].
12. getReviewerExecutor(pod: Pod): ReviewerExecutor | undefined.
13. getPodValidationSkipPhases(profile: PodExecutionSettings, pod: Pod): ValidationPhase[].
14. emitActivityStatus(podId: string, message: string): void.

Import the existing CONTAINER_APP_PORT, buildValidationContextEnv,
parseDiffFilePaths, resolveReviewerModel and resolveReviewerProvider directly from
their current modules. Keep shared manager helpers in place and inject them;
no new exports from pod-manager.ts and no circular import.

Return this operation and result:

    prepareValidationInputs(
      pod: Pod,
      profile: PodExecutionSettings,
      s1: Pod,
      attempt: number,
      validationSuite: NonNullable<PodOptions['validationSuite']>,
    ): Promise<PreparedValidationInputs>

    interface PreparedValidationInputs {
      validationConfig: ValidationEngineConfig;
      previousValidation: StoredValidation | null;
    }

Derive local podId from pod.id. Move the exact contiguous region identified above.
The only moved-body receiver adaptation is deps.pendingOverrideRepo to
 overrideSource.pendingOverrideRepo. Pass the original manager deps object as
 overrideSource so the optional property is still read when flush executes; do not
capture a one-time repository property value or move the flush earlier.
The final return may use a type-only `validationConfig as ValidationEngineConfig`
assertion: the manager's existing containerId guard dominates this call, while the
body must keep reading pod.containerId at its original post-await construction point.
Do not add a second guard, copy/freeze pod, or capture containerId earlier.

Compose immediately after createValidationAttemptStart, without factory I/O.
Replace the whole assembly block with:

    const { validationConfig, previousValidation } =
      await prepareValidationInputs(pod, profile, s1, attempt, validationSuite);

Keep validationSyncOk, the surrounding try/catch, controller construction and
claimValidation at their current relative positions. Permit imports/composition,
typed wrapper, local podId, final typed return, the single receiver adaptation,
delegation and formatting only. Compare the complete remaining manager against
that exact recipe, not just the extracted statements.

## Compatibility requirements

1. Base-branch and start-commit fallbacks use the same nullish semantics, including
   explicit empty strings. Preserve all four Git call arguments and concurrent
   diff/log reads. Protected paths use the base-branch path set when available,
   with diff parsing only as the current fallback. No worktree means empty source
   inputs; other reviewer/environment/history preparation still runs.
2. Environment and reviewer helpers keep their current timing, argument identity,
   effects and repeated resolution. Reserved validation context keys override build
   env collisions. Do not change account routing or expose credentials in evidence.
3. Review-skill candidate order and swallowed read errors remain shared-helper
   behavior. The protected-path guard precedes skill/reviewer/history/override work.
4. Capture chronological history before this new attempt is inserted. Preserve
   returned previousValidation identity. Do not replace it with attempt arithmetic.
5. Flush follows history reads. Incoming override values win by findingId without
   reordering existing keys; empty queue does not write. Preserve queue deletion
   and subsequent pod write as separate effects. Do not silently add atomicity.
6. Preserve every config field, omission versus explicit undefined, fallback,
   timeout conversion, provider/account/credentials/executor reference, task and
   brief field, API-key rule and skip-phase snapshot. Most fields use pod; skips use s1.
7. A preparation failure remains in the manager's existing catch, with the same
   error and preceding effects. It must not claim validation ownership or run the
   engine. No new rollback, fencing, lifecycle state or policy is introduced.

## Scope exclusions

No manual revalidation unification, engine execution/retry/result extraction,
container/workspace policy change, source rewriting, helper cleanup, transaction,
API/schema/profile/dependency change or new security/admission rule. No live
provider/container run, deployment, PR creation, main integration or separate Git
maintenance-race fix. These remain separate work.

## Phase 1: characterize public input preparation

Only change pod-manager.test.ts. Add a `validation inputs compatibility` group
using public triggerValidation and the existing real SQLite manager fixture.
Inspect the first engine config or hold a current infrastructure seam to inspect
pre-engine effects. Use distinguishable pod/s1 observations only through existing
seams; do not import the future module or add product hooks. Reuse current tests
when they already prove an outcome rather than duplicating them.

Cover:

- Docker/sandbox probes and preview fallback; profile/default/nullish/zero values,
  timeout conversion, optional task/contract/brief/plan/summary/pre-submit fields,
  advisory setting, suite and skip phases. Inspect the real config, not a copy of
  the implementation in an expected-object builder.
- Pod/profile/main base choice and startCommitSha; exact Git args; no-worktree
  source values; optional getChangedPathsAgainstBase absence; protected paths
  blocked/explicitly scoped/inherited-from-base using real manager guard behavior.
- Environment merge precedence and relevant bound-launch/legacy reviewer behavior
  using existing fixtures; private registry/reviewer helper calls retain existing
  provider/account selection and current capability checks. No external provider call.
- Held diff/log prove both start before either is released, and later assembly does
  not run before both finish. Restore/release/join held work in finally.
- Previous history and prior batch across reset attempts; queued override replacement,
  persistence and empty queue. Enqueue while an earlier awaited seam is held and
  check it is consumed at the original late flush point.
- Failures before flush leave queue/pod overrides intact. Failures after flush
  preserve consumed queue and any prior override write. The engine is not called;
  the manager's existing failed/stop handling remains observable. Reuse existing
  update-intent/supersession cases to protect the outer catch boundary.
- Manual revalidation retains its distinct config and override-queue handling.

Freeze baseline product/test hashes, exact selected tests and raw passing before
results under ignored .autopod-data/validation-inputs/. Record corrections before
freezing. Close DBs, restore spies/environment/timers and clean private fixtures.

### Success criteria

Automated:
- [x] Public characterization and relevant existing cases pass on unchanged product.
- [x] Runtime/SQLite identity, frozen assertions and before results are recorded.

Manual: None required for this headless compatibility boundary.

## Phase 2: extract and prove actual inputs and override persistence

Apply the exact two-file product move. Keep Phase 1 assertions byte-identical.
Add validation-inputs.test.ts importing the actual module. Use migrated private
file-backed SQLite and real pod, pending-override and validation repositories for
persistence/history claims. Use narrow callbacks for helper contracts; do not
claim controlled helpers prove provider or Git internals.

Direct cases must prove:

- Complete config observations for explicit/default/zero/empty/null values and
  absent/present optional inputs; same reference identities where the original
  body passed through objects, executor and credentials. Distinguishable pod/s1
  values demonstrate each field uses the original intended input.
- Actual close/reopen observes queue consumption and merged overrides; run SQLite
  integrity_check and foreign_key_check. Confirm another pod's queue is untouched.
- Real chronological records across attempt resets select the prior history/batch;
  keep previousValidation reference identity from the actual repository result.
- Concurrent held Git reads, environment overlay, no-worktree and optional-method
  fallback; exact dependency order and args, including post-await property reads.
- Failures at environment, either Git read, paths/guard, skill callback, reviewer
  config/env, history, flush, pod write and later config construction preserve error
  identity and preceding effects. A real SQLite trigger rejecting the override
  update demonstrates that the earlier queue flush remains consumed. A controlled
  late getReviewerExecutor throw demonstrates overrides were already persisted.
- Empty queue avoids writes; factory construction performs no I/O. Keep shared
  helper implementations unchanged and verify actual public helper behavior via
  manager tests rather than substituting callback assertions for it.

Compare parsed TypeScript tokens for the moved region and complete remaining
manager against the explicit recipe. Capture changes and actual line counts.

### Success criteria

Automated:
- [ ] Frozen public cases pass unchanged after extraction.
- [ ] Direct config/order/error and real SQLite close/reopen checks pass.
- [ ] Exact movement proof and four-path product/test scope pass.

Manual: None required; live provider/container qualification is not claimed.

## Phase 3: qualify frozen final source

Use the established ignored task-local launcher with Node 22.23.3 and pnpm 9.15.4;
confirm actual child runtime and opened SQLite. Freeze final package/test/script
hashes and compare after checks. Record raw commands, exit codes, actual counts,
skips, corrections and limitations under .autopod-data/validation-inputs/.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation inputs compatibility|passes diff-scoped validation base context|keeps validation review cycle continuity|protected operational|inherited from the base|passes profile build env'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-inputs.test.ts
    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-inputs.ts packages/daemon/src/pods/validation-inputs.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

For affected coverage, run the predecessor plan's explicit 38-file Vitest command
plus these five verified suite paths (43 total), without name filters:

- src/pods/validation-inputs.test.ts
- src/validation/validation-context-env.test.ts
- src/validation/review-context-builder.test.ts
- src/pods/runtime-resolver.test.ts
- src/pods/registry-injector.test.ts

Save the full expanded command and result, not just this description. The full
pipeline uses frozen install, uncached lint/build/supported declaration typecheck/
tests/audit/secret scan with SQLite enabled. No fallback lockfile mutation.
The inherited process-only Git setting avoids the reproduced maintenance.lock
race in unchanged managed-source test fixtures. Do not alter global/repo config,
skip that suite or claim the separate race is fixed. Recheck source hashes after
qualification, review the final diff, commit/push verified increments and verify
remote identity and a clean worktree. Do not copy predecessor test counts as proof.

### Success criteria

Automated:
- [ ] All 43 affected suites pass with SQLite and no new skips.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint, whitespace, frozen hashes and exact movement review pass.
- [ ] Evidence records actual runtime/results/limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove manager composition, actual shared helpers and catch behavior.
Direct tests prove the extracted input contract and actual SQLite override/history
effects. Existing suites protect source, registry and reviewer implementations.
The full run qualifies local mocked-infrastructure compatibility, not live deployment
or new atomicity, crash recovery, provider availability or cross-process guarantees.

Keep Promise.all and the same I/O/call count. The wrapper adds one awaited function
boundary; no performance improvement is claimed. No schema, API or dependency
migration. Revert module and wiring together. Main integration remains separate.

## References and next action

- Research: ../research/2026-10-17-pod-manager-validation-inputs.md.
- Predecessor: 2026-10-17-pod-manager-validation-attempt-start.md (complete).
- Current sources: pod-manager.ts:13663–13776; interfaces/validation-engine.ts;
  pending-override-repository.ts; validation-repository.ts; validation-context-env.ts.

Next action: review this concrete plan. After explicit approval, execute all three
phases together. No implementation or test execution has started.

## Implementation notes and Phase 1 evidence

The user approved all three phases together. 28 new public cases plus five existing
cases pass against unchanged product source (33 passed, 919 name-filtered). Frozen
public assertions and baseline package/script hashes are recorded privately.
Scoped Biome passes with no warnings. New-group semantic diagnostics are zero.
Initial failing fixture runs are retained: a mock implementation recursively called
itself, brief fields were incorrectly updated rather than seeded at creation, and
manual revalidation without force correctly skipped when no commits were pulled.
Corrections preceded the frozen passing baseline; no product behavior changed.

Two implementation details preserve approved scope and interfaces:
- CONTAINER_APP_PORT is actually local to the manager, not an importable shared
  export as the plan said. The new module defines the same local constant 3000.
  No shared helper/export or other caller changes.
- The 1,045,458-byte existing manager test file crosses Biome's 1 MiB processing
  ceiling after adding cases. An ignored task-local npx launcher adds only
  --files-max-size=2097152 to root lint. Scoped Biome uses the same CLI flag.
  No rules, files or checks are disabled; repository configuration is unchanged.
  BIOME_CONFIG_PATH was not honored by this installed CLI; that initial attempt
  is retained. Full qualification must use the task launcher and report this limit.

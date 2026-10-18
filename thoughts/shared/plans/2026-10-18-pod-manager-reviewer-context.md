# Slice 15: reviewer context extraction

Status: COMPLETE — all three approved phases implemented and locally verified.
Date: 2026-10-18.
Baseline: 2cdb48e56551f69f235585c9b12316d3e8409eee.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Give reviewer profile/account selection, legacy environment preparation and isolated
executor selection one internal module. Preserve their current routing, refresh and
error boundaries. Continue the established characterize → extract → qualify
structure. Approval of this plan covers all three phases together, with no
intermediate manual gate for this headless compatibility extraction. Commit/push
verified increments per the user's repository instructions. Planning changes no
product code; implementation starts after approval.

Research: ../research/2026-10-18-pod-manager-reviewer-context.md.

## Current state and desired boundary

pod-manager.ts is 16,995 lines. Three contiguous helpers occupy :5163–5349
(187 lines including separating blanks): buildReviewerExecEnv,
getEffectiveReviewerConfig and getReviewerExecutor. They supply ordinary validation,
manual revalidation, existing public reviewer methods and launch memory. Existing
isolated-reviewer, account/credential/env helpers and provider routing own their
current lower-level behavior.

Exactly two product paths change:
- New packages/daemon/src/pods/reviewer-context.ts.
- packages/daemon/src/pods/pod-manager.ts: import/composition, remove the three
  original definitions and the now-unused resolveEffectiveReviewerProfile import.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/reviewer-context.test.ts: direct contracts with
  actual configuration/account/provider helpers and private file SQLite.

The manager retains bound-profile selection/failover authority, provider attempt
creation/closure, worker resume/persistence and MAX lineage updates, lifecycle and
validation policy. Validation provenance and actual isolated executor implementation
stay unchanged. No schema/API/profile/state/dependency changes, new provider policy,
credential flow, extra refresh, paid request, integration to main or deployment.

## Implementation approach

Add createReviewerContext with TWO arguments so the distinction between live
manager properties and previously captured collaborators remains explicit:

    createReviewerContext(deps, captured)

The first argument is the ORIGINAL manager dependency object, accepted only through
this narrow structural view declared locally in reviewer-context.ts:

    launchConfiguration?: {
      read(podId: string): EffectiveLaunchConfig | null;
      reviewer?: Pick<IsolatedReviewer, 'executor'>;
    }
    providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>

Do not copy/destructure these properties. Existing bodies keep deps.launchConfiguration
and deps.providerAttemptRepo lookups, including repeated reads and original receivers.
No runtime/type import of PodManagerDependencies is required.

The second argument contains exactly eight already captured references, destructured
once by the factory under the same original local names:

    providerAccountStore?: ProviderAccountStore
    providerCatalog?: PublicProviderCatalog
    profileStore: ProfileStore
    containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager }
    logger: Logger
    maxCredentialLineageByPod: Pick<Map<string, MaxCredentialLineage>, 'get'>
    executionForPod(pod: Pod): PodExecutionSettings
    resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings

Retain stores/factory/map/functions by reference, not derived values or bound methods.
Return the original names/signatures, including the executor's optional purpose:

    buildReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>
    getEffectiveReviewerConfig(pod: Pod): {
      profile: PodExecutionSettings; credentials: ProviderCredentials | null;
    }
    getReviewerExecutor(pod: Pod, purpose?: 'review' | 'memory'):
      ReviewerExecutor | undefined

Keep default purpose='review' inside its original function. Move all THREE complete
bodies unchanged, including their internal helper calls, catches, loops and object
spread order. Add only typed dependency/return surfaces and a no-effect factory.
Import existing AutopodError, assertLaunchAgentAccount, buildProviderEnv, the three
persistence helpers and resolveEffectiveReviewerProfile. Retain all imports with
other manager uses; only resolveEffectiveReviewerProfile becomes unused there.

Compose at the former three-definition site, immediately after getResumeEnv and
before persistRuntimeCredentialsForPod. This is after the MAX map initialization
and before validation input composition. Keep every external call and shorthand
injection/public export unchanged. Existing public wrappers remain in manager.
No new shared/index export, wrapper around dispatch, or helper injection for testing.

Use parsed TypeScript to compare the entire remaining manager and new module with
this exact recipe; separately compare all three original function bodies, external
calls and shorthand references. Internal calls/awaits are included in body equality.
Allow imports, factory types/composition, definition removal and formatting only.
No normalization, receiver replacement, eager capture, policy correction or new catch.

## Compatibility requirements

1. Factory construction reads no launch/account/profile/history, recovers no auth,
   writes no files and obtains/invokes no executor. Keep original captured objects
   and live dependency-property lookups; repeated calls see replaced live properties
   and late store/factory/map methods exactly as before.
2. Independent launch configuration requires the same account store and actual
   assertLaunchAgentAccount check before credential/profile overlays. Preserve route
   identity, account-createdAt/catalog policy checks and existing errors. Follow-main
   uses the bound profile, account credentials or null, and reviewerModel=defaultModel.
3. Legacy selection branches on ANY attempt history, including closed history;
   absent/empty history keeps the snapshot routing resolver. Account credentials
   remain current; profile credential fallback exists only in the original branch.
   Keep the fallback digest/missing-credentials error and earlier error precedence.
4. No digest: executor returns undefined before launch reads. Digest: require launch
   plus reviewer service, resolve config and forward pod/launch/route/purpose with
   original receiver. Independent passes the existing route object; follow-main
   overlays four fields with nullish fallback. Return the executor without invoking
   it. Existing memory caller retains purpose='memory'.
5. Digest-backed env preparation calls getReviewerExecutor then returns undefined;
   it does not write reviewer auth into the worker container. The non-digest path
   resolves config before its independent-launch guard and before provider filtering.
6. Preserve max/foundry/openai/pi filtering, container/no-container behavior and
   recovery owner from pod.providerAccountIdSnapshot. MAX lineage is read from the
   existing map. Foundry skips container recovery. Keep initial provider selection,
   warning payload/message, swallowed recovery errors and unconditional post-recovery
   config re-read; target lookup before the try and later errors still propagate.
7. Preserve buildProviderEnv arguments: refreshed profile/credentials, runtime,
   conditional pod binding and original stores/catalog. Do not add lineage updates,
   credential fallback, capability check, ownership check or additional refresh.
8. Keep sequential containerFiles, then secret write→chmod0400 (timeout5,000), no
   new write mode or transaction. Preserve rejection identity/earlier write prefix,
   account updates and exact return spread { POD_ID: pod.id, ...result.env }.
9. Existing isolated executor retains launch/account/lifecycle checks, timeout,
   failover budget, network/cleanup and provenance policy. This extraction proves
   setup compatibility, not a new isolation, atomicity or remote execution guarantee.

## Phase 1: characterize public reviewer setup

Only edit pod-manager.test.ts. Append `reviewer context compatibility`, exercising
existing getReviewerConfig/getReviewerExecEnv/getReviewerExecutor and launch memory,
plus ordinary triggerValidation and manual revalidateSession engine configuration.
No future-module import or production-only seam. Use the real migrated manager
context and existing configuration test helpers/account stores/snapshots for launch
fixtures, with controlled typed executor/container boundaries.

Pin launch independent versus follow-main and legacy empty/history/snapshot paths,
current account credentials, revocation/rebinding, missing account/launch/reviewer
errors and their order. Pin default review and explicit memory purpose, route identity
versus copied overlay, no executor invocation at selection, and digest env early
return/no worker writes. Exercise actual Codex rotated-auth recovery and resulting
engine config; include MAX/Pi/Foundry branches where reachable without external auth.
Record legacy skip behavior and file-write order/failure prefixes through existing
seams. Select existing snapshot/SDK/CLI/provider-failover/ownership cases as relevant.

Use the exact Phase3 filter (existing names verified), retain selected names and run
against unchanged product. Freeze public test bytes, before-source, original three
regions, baseline package/script/six root hashes and actual runtime before extraction.
Retain initial diagnostics/corrections honestly. Close DBs, release and join deferred
work in finally, restore mocks/env/clocks and remove only private fixture files.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen assertions/filter, before-source/hashes/runtime and raw results recorded.

Manual: None required for local headless setup compatibility.

## Phase 2: extract and prove reviewer context contracts

Apply the two-product-file recipe. Keep public assertions byte-identical. Add direct
tests against the actual factory using complete typed pod/profile/launch fixtures,
actual runtime resolver/assertLaunchAgentAccount, real account/attempt repositories,
and actual provider env/persistence helpers for deterministic local credential cases.
Spies on existing helper modules may reach rare warning/error paths; identify those
as controlled boundaries. Add no production seam or remote credential refresh.

Configuration/executor matrix:
- Construction without effects; no launch versus independent/follow-main; account
  store missing, credentials absent, account identity/catalog/runtime rejection and
  error identity/order. Keep profile copies/nested references and current credentials.
- Absent, empty, open AND closed provider history; original snapshot projection,
  credential fallback/null and digest/error precedence. No side-effect attempt write.
- No-digest early executor return; missing launch/reviewer; independent route identity;
  follow-main four nullish overlays; default review and explicit memory purpose;
  original service receiver and exact returned executor, with zero invocation.
- Replace live launchConfiguration/providerAttemptRepo properties and their methods
  after construction; replace captured-argument wrapper properties without replacing
  the retained originals. Test late account/store/factory/map method changes.

Environment matrix:
- Digest early check/return; non-digest independent guard and provider filtering;
  max/openai/pi recovery with/without container, Foundry no recovery; owner and MAX
  lineage arguments, re-read after success and warning, and unchanged warning data.
- Actual OpenAI/Pi rotation with local JSON and MAX setup-token/nonexpired fixture
  credentials. Foundry static key path is local; token refresh/error paths use existing
  controlled provider boundaries. Assert no network/ambient credential requirement.
- Actual buildProviderEnv binding/runtime/current account parameters and env; write
  ordering, missing container, containerFiles then secret files with chmod timeout.
  Hold a write/recovery to verify sequential behavior and late reference/config reads.
- Existing thrown-error identity and durable prefixes for recovery/build/first/later
  write/chmod errors. Recovery errors alone are swallowed; later failures propagate.
  Controlled builder output can pin spread precedence without changing production.

Use private migrated FILE SQLite with actual account store/provider attempt repository
and pod repository/task registration. For actual rotated auth verify only the selected
account changed, retained other-account/profile evidence, attempt rows unchanged,
close/reopen integrity/FK and durable update prefix if a later write fails. Use
synthetic fixture credentials only. Real credential persistence/locks/builders remain
unchanged and their own suites remain selected. These tests do not establish a new
cross-process transaction or actual provider authorization.

### Success criteria

Automated:
- [x] Frozen public checks pass unchanged after extraction.
- [x] Direct config/executor/env and real SQLite/account/persistence/reopen checks pass.
- [x] Three-body recipe, unchanged calls/references and two-product/two-test scope pass.

Manual: None required. Live paid providers, Docker and Azure remain outside scope.

## Phase 3: qualify frozen final source

Reuse the task-local launcher with verified Node22.23.3 / pnpm9.15.4 and opened
SQLite3.49.2. Record actual versions anew. Freeze final package/script and six root
hashes, actual commands, counts/skips and logs/exits under ignored
.autopod-data/reviewer-context/. Supplemental semantic diagnostics cover both new
test boundaries. Root supported declaration typecheck remains unchanged.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'reviewer context compatibility|fallback provider for post-failover validation review|legacy pod reviewer bound|recovers and rewrites fresh Codex auth.json|validation provenance compatibility|validation admission lifecycle ownership|validation execution compatibility'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/reviewer-context.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/reviewer-context.ts packages/daemon/src/pods/reviewer-context.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run Slice14's explicit 70-suite daemon affected command plus these NINE distinct
paths, without name filters (79 suites):
- src/pods/reviewer-context.test.ts (new).
- src/configuration/pod-snapshot-integration.test.ts.
- src/configuration/agent-route-resolution.test.ts.
- src/validation/isolated-reviewer.test.ts.
- src/provider-accounts/provider-account-store.test.ts.
- src/pods/provider-attempt-repository.test.ts.
- src/providers/env-builder.test.ts.
- src/providers/credential-persistence.test.ts.
- src/providers/memory-reviewer.test.ts.

The inherited command is retained in
.autopod-data/validation-provenance/affected-command.json. All eight existing
additions were verified distinct and present. If private evidence is unavailable,
reconstruct the explicit list from predecessor evidence before executing. Record
the resolved 79-path command; do not silently replace it with a narrower selection.

Run full frozen install/lint/build/typecheck/test/audit/secret scan uncached with
SQLite enabled, no new skips and no source changes during qualification. Preserve
process-only maintenance.auto=false and root lint --files-max-size=2097152, without
rule/file-selection/config changes. Retain/investigate failures before unchanged
reruns; known unrelated Git metadata-scan race/audit-clock flake stay outside scope.
Slice14's 8,172 tests/35 script tests are baseline evidence only, not this slice's
result. Recheck movement/diff/frozen hashes, complete actual proof/limits and plan,
commit/push verified increments and confirm remote identity and clean checkout.

### Success criteria

Automated:
- [x] All 79 affected suites pass with SQLite and no new skips.
- [x] Full uncached validation passes under the documented qualification environment.
- [x] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [x] Complete plan/proof records actual results, limits and final pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public manager checks establish integration/caller policy; direct tests establish
factory/capture/order and actual local credential/account/attempt behavior. Existing
isolated-reviewer and SDK/CLI suites establish their current local contracts. No
performance improvement or stronger security guarantee is claimed. No migration.
Revert manager composition and the new module together. PR/main/deployment remain
separate work. No unresolved product choice or manual acceptance step is required.

## References and next action

Research: ../research/2026-10-18-pod-manager-reviewer-context.md.
Predecessor: 2026-10-18-pod-manager-validation-provenance.md (complete).
Source regions: pod-manager.ts:5163–5349, :5484–5487, :14266–14300, :14705–14726;
pods/runtime-resolver.ts; configuration/agent-route-resolution.ts;
validation/isolated-reviewer.ts; providers/env-builder.ts;
providers/credential-persistence.ts; provider-accounts/provider-account-store.ts;
pods/provider-attempt-repository.ts; interfaces/reviewer-executor.ts;
configuration/pod-snapshot-integration.test.ts and existing manager reviewer tests.

All three approved phases are complete. No manual acceptance remains.
Integration, PR creation and deployment remain separate work.

## Phase 1 observed results

16 new public cases plus 82 selected existing cases pass against unchanged product:
98 selected, with 1,036 unrelated tests excluded only by this name-filter run.
The new group covers real composed admission/snapshots/account stores, independent
and follow-main identity, review/memory selection, isolated env, account revocation,
missing launch/reviewer, absent/empty/open/closed legacy history, actual Codex
rotation and retained account update on later write failure, both validation entry
configs, and captured store/live property behavior. Public semantic diagnostics
are clean. Assertions/filter and before-source are frozen before extraction.

Initial diagnostics caught fixture requirements: composed admission needs its legacy
profile FK row; attempt references require the actual snapshot hash format; memory
calls require maxTokens; manual revalidation with no new commits requires force.
The write-failure fixture now fails specifically on auth.json after earlier config
files. Existing callers capture reviewerProviderCredentials before env recovery:
the engine config therefore retains that earlier snapshot while the account and
written auth are fresh. Tests explicitly pin both observations. This extraction
preserves that order; no product correction or assertion weakening was made.
Initial logs/exits are retained alongside the passing baseline.

## Phase 2 observed results

createReviewerContext now contains the three complete original bodies. The manager
passes its original dependency object through the narrow live view, with eight
original captured collaborators. It composes the factory at the former definition
site. Parsed TypeScript verifies the complete manager/module recipe, all three
bodies including internal calls/awaits, seven external calls (2 env / 3 config /
2 executor), and four shorthand references (three input injections and public
executor export). The manager is 16,820 lines, 175 fewer; reviewer-context.ts is
254 lines. All 1,971 other baseline package/script paths are unchanged.

The frozen 98 public checks pass after extraction with byte-identical assertions.
All 72 direct cases pass using private migrated file SQLite, actual account/attempt/
pod repositories, account identity/runtime resolver and actual local credential/
env helpers. Tests cover closed history, nullish route overlays, review/memory,
no eager dispatch, captured/live references, real OpenAI/Pi rotation, nonexpired
MAX, controlled Foundry token acquisition, sequential writes and errors. A real
SQL credential-update abort warns and reuses old auth; earlier account updates
survive later auth-write failure. Reopen integrity/FK checks and untouched other
account/profile/attempt evidence pass. All 79 affected suites pass: 2,840 tests,
zero skipped. Scoped Biome/whitespace are clean; semantic diagnostics are zero in
both new test boundaries. No product correction followed extraction.

The initial direct run had one expectation error: actual account auth resolution
rejects non-runnable catalog policy first with PROVIDER_ACCOUNT_NOT_RUNNABLE.
That exact existing precedence is now pinned. Two initial multi-variable test
fixture declarations were split to satisfy Biome. The movement verifier needed
import ordering normalization and a missing trailing type-member semicolon in its
generated recipe; original body equality remains exact and no product edit was
needed. Diagnostics and corrected passing runs are retained.

Final source/configuration hashes and commands/environment are frozen under
ignored .autopod-data/reviewer-context/. Full uncached qualification remains.

## Phase 3: final qualification

Verdict: PROVEN for the approved local reviewer context compatibility extraction
under the documented qualification environment. All three phases are complete.

| Claim/check | Observed final evidence | Result |
|---|---|---|
| Public compatibility | 98 selected before/after checks, 16 new; assertions byte-identical | Passed |
| Context and persistence contracts | 72 direct cases using private migrated file SQLite and actual account/attempt/auth/env helpers | Passed |
| Surrounding orchestration | 79 affected suites; 2,840 tests passed; zero skipped | Passed |
| Full uncached pipeline | Frozen install, lint, build, supported declaration typecheck, all tests, audit and secret scan | Passed under documented environment |
| Vitest | 8,260 passed across 502 passing files; 10 existing gated skips | Passed with existing skips |
| Standalone Node scripts | 35 passed; zero failed/skipped | Passed |
| Source integrity | 1,975 package/script hashes and six root controls unchanged through qualification | Passed |
| Exact movement/scope | Three original bodies, seven external calls, four shorthand references and full recipe; two product/two test paths | Passed |
| Scoped quality | Biome/whitespace clean; zero semantic diagnostics at both new test boundaries | Passed |

Tested implementation: ce049230f99c0bdd7515391887947d196efa3b70. The following documentation-only commit
records qualification without changing qualified source/test bytes. Final pushed
identity and clean-checkout confirmation are recorded privately after push.

Actual full command through the task-local pinned launcher:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Actual child Node22.23.3 opens SQLite3.49.2; pnpm9.15.4. Build/typecheck/test groups
ran uncached. Frozen install succeeded without fallback or lockfile mutation.
Root lint retained 82 existing warnings and used only --files-max-size=2097152
for the large manager test. Scoped files are clean; no rule/file selection or
repository/global configuration was changed. maintenance.auto=false is process-only.
The known unrelated metadata-scan race and audit-clock flake remain outside scope.
No source/test changes occurred during final qualification; the 10 existing
gated skips remain and no new test was skipped.

The manager is 16,820 lines, 175 fewer; reviewer-context.ts is 254 lines. All three
bodies/internal calls/awaits retain their original behavior. External env/config/
executor calls, validation input injections and the public executor reference are
unchanged. Bound-profile/failover authority, worker resume/persistence and lineage
updates, lifecycle/validation policy, provenance and actual isolated dispatch remain
under their original authority. All 1,971 other baseline package/script files match.
No product correction followed extraction.

Evidence is retained under ignored .autopod-data/reviewer-context/: proof.json,
claims.json, movement.json, manifests, frozen public assertions/filter, before-source,
original regions/exact recipes and scripts, actual runtime/commands, raw public/
build/direct/affected/full/lint/type logs/exits, initial diagnostics and identities.
The illustrated approval document remains the original proposal snapshot.

Tests establish setup compatibility with actual local account/credential persistence,
closed history, route/error precedence, reference timing, purpose/receiver behavior,
no eager executor dispatch, sequential writes and SQL abort/reopen boundaries.
Callers still capture reviewer credentials before env recovery; tests pin the earlier
engine config alongside fresh account/written auth. Container/executor interfaces
and Foundry token acquisition are controlled. Local evidence does not establish paid
provider authorization/execution, live Docker/Azure, stronger isolation, atomicity,
dispatch fencing, crash recovery or remote completion guarantees.

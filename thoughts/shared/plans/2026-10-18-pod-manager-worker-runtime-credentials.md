# Slice 16: worker runtime credential extraction

Status: APPROVED — implementing all three phases after explicit user approval.
Date: 2026-10-18.
Baseline: b10a505a6c479fec4ea6225ac6c983a386008fd9.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Move worker resume environment preparation and post-run credential persistence into
one internal module. Preserve their current auth owners, refresh order, file modes,
lineage timing and warning/error boundaries. Continue the established
characterize → extract → qualify structure. Approval covers all three phases together;
no intermediate manual gate is needed for this headless compatibility extraction.
Commit/push verified increments per the user's repository instructions. Planning
changes no product code; implementation begins after explicit approval.

Research: ../research/2026-10-18-pod-manager-worker-runtime-credentials.md.

## Current state and desired boundary

pod-manager.ts is 16,820 lines. getResumeEnv occupies :5036–5162 (127 lines including
separating blank); persistRuntimeCredentialsForPod occupies :5175–5224 (50 lines).
The reviewer-context composition sits BETWEEN them and must remain unchanged.
The first helper has two external calls; the second has eight awaited calls.
Their callers own lifecycle admission, provenance, runtime dispatch and cleanup.

Exactly two product paths change:
- New packages/daemon/src/pods/worker-runtime-credentials.ts.
- packages/daemon/src/pods/pod-manager.ts: factory import/composition, remove the
  two original definitions and the three now-unused persistence named imports.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public worker characterization.
- New packages/daemon/src/pods/worker-runtime-credentials.test.ts: direct contracts
  and private file SQLite using actual account/credential/provider helpers.

Keep bound-profile/failover authority, initial provisioning, validation/registry env,
launch credential resolution, lineage map/remember/forget functions, reviewer context,
lifecycle and actual continuation/cleanup dispatch in their current modules.
No API/schema/profile/state/dependency change, new provider policy, credential flow,
additional refresh/replay, paid provider call, main integration or deployment.

## Implementation approach

Add createWorkerRuntimeCredentials(deps, captured) with two arguments. The first is
the ORIGINAL manager dependency object through a locally declared narrow live view:

    launchConfiguration?: {
      read(podId: string): EffectiveLaunchConfig | null;
      assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    }

Do not eagerly copy/destructure launchConfiguration or cache its methods. Keep the
original deps.launchConfiguration reads, optional lookup and receivers in both bodies.
No PodManagerDependencies import is needed.

The second argument captures these TEN existing references under their original names:

    podRepo: Pick<PodRepository, 'getOrThrow'>
    providerAccountStore?: ProviderAccountStore
    providerCatalog?: PublicProviderCatalog
    profileStore: ProfileStore
    containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager }
    logger: Logger
    maxCredentialLineageByPod: Pick<Map<string, MaxCredentialLineage>, 'get'>
    resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings
    validationEnvironmentForPod(pod: Pod, profile: PodExecutionSettings):
      Promise<Record<string, string> | undefined>
    rememberMaxCredentialLineage(podId: string, result: ProviderEnvResult): void

Retain the same objects/functions rather than derived values, copied maps or bound
methods. Destructure captured once; construction performs no collaborator work.
Return exactly the original names/signatures:

    getResumeEnv(pod: Pod): Promise<Record<string, string> | undefined>
    persistRuntimeCredentialsForPod(podId: string, logMessage: string): Promise<void>

Move both COMPLETE bodies unchanged and carry the existing resume-helper doc comment
with it. Preserve the wording of existing comments; this is a compatibility move.
Keep all catches, awaits, object spreads, loops, callback/method lookups and arguments.
Use original imports of buildProviderEnv and the three persistence helpers, with
only type imports for infrastructure. No new testing seam or shared/index export.

Compose at the former getResumeEnv comment/definition site, after required maps
are initialized and immediately BEFORE existing reviewer-context composition. Remove
the later persistence definition separately. Keep reviewer composition intact.
Remove only persistOpenAiAuthJson, persistPiAuthJson and persistRefreshedCredentials
from the manager's provider import group. Keep buildProviderEnv, MaxCredentialLineage
and ProviderEnvResult because initial provisioning/lineage callbacks still use them.

Verify parsed TypeScript against the complete explicit manager/module recipe, plus
both exact original bodies and all TEN external calls (2 env and 8 persistence),
including original awaits, conditions, caller-specific messages and arguments.
Allow typed factory/dependencies, import changes, composition, definition removal
and formatting only. No body normalization, receiver substitution, extra catch,
profile re-read, ownership fence, cached service or credential-policy correction.

## Compatibility requirements

1. Resume resolves its bound profile, reads launch and, when present, awaits existing
   validationEnvironmentForPod BEFORE provider skips/recovery. Legacy accepts only
   max/foundry/openai/pi; legacy Foundry with static key/missing or mismatched creds
   returns undefined. Launch-backed calls bypass those legacy skip gates.
2. Resume recovery owner is from the initially resolved profile, not directly from
   the pod snapshot. MAX/OpenAI/Pi with a container retain separate try/catch blocks
   and distinct warning messages; target-manager lookup stays inside each catch.
   No container skips recovery. Foundry has no container readback.
3. Preserve the initial profile across awaits and pass it to buildProviderEnv without
   a new bound-profile re-read. Actual provider helper account reads still see current
   credentials. Keep original runtime/conditional pod binding/store/catalog arguments.
4. rememberMaxCredentialLineage runs after buildProviderEnv and BEFORE file writes,
   including with no container. It still sets/deletes the manager's original map.
   Earlier account/lineage effects survive later write or capability failures.
5. Keep sequential container files then secrets: launch container files mode0600,
   launch secrets mode0400 and no chmod; legacy container files have explicit fourth
   argument undefined, legacy secret writes have no mode then chmod0400/5,000 ms.
   Preserve no-container behavior and first/later write or chmod failure prefixes.
6. A saved launch retains the late optional deps.launchConfiguration capability call
   AFTER writes. Keep original launch argument and receiver. Replacement/removal of
   the live service has its existing effect; add no stronger check. Return ordering
   remains { ...buildEnv, ...result.env, POD_ID: pod.id }.
7. Persistence reads podRepo.getOrThrow OUTSIDE the try, then no-container returns
   before profile lookup. Inside the try, resolve a fresh bound profile, accept only
   max/openai/pi and retain its profile-derived owner and MAX lineage. Profile,
   target and provider errors warn with the supplied caller message and are swallowed.
   Missing-pod and a logger throw retain their current propagation.
8. Persistence adds no build/env rewrite/lineage update. Captured collaborators keep
   their original identity with late methods; live dependency-property reads stay
   on the original manager object. Factory construction has no effects.
9. Callers retain their existing awaits, conditions, stopped/superseded outcomes,
   provenance fences, teardown order and messages. This slice proves setup/readback
   compatibility; it does not create atomicity, stronger auth ownership, dispatch
   fencing, replay safety, cross-process locking or remote execution guarantees.

## Phase 1: characterize public worker credential boundaries

Only edit pod-manager.test.ts. Append `worker runtime credential compatibility`.
Exercise actual worker paths: human-message sendMessage and rejection/task-feedback
resume for getResumeEnv; processPod exit/error and kill for post-run persistence.
Use current migrated manager context and actual account stores with synthetic local
JSON credentials, existing configuration/snapshot helpers for launch cases, and
controlled runtime/container/provider boundaries. No future-module import or new
production-only seam.

Pin fresh auth persistence and file/env order before runtime.resume, and post-run
readback before relevant completion/cleanup. Cover supported provider local paths,
legacy early returns, missing container/binding and warning/error outcomes. For
launch-backed resume pin validation/registry env, mode0600/0400, capability recheck
and absence of worker dispatch when that existing check rejects. Verify current
owner despite profile edits/account revocation and retain earlier persisted effects
when later preparation fails. Include rejection and human-message entry differences.

Select existing worker persistence, continuation/provenance/decision-ownership,
recovery and reviewer compatibility tests. The old test named 'recovers and rewrites
fresh Codex auth.json for resume env from provider account' calls getReviewerExecEnv:
retain it as reviewer evidence, and do not count it as proof of getResumeEnv.
Use this exact selection, record actual selected names and freeze before extraction:

    worker runtime credential compatibility|persists Codex auth.json back|fresh runtime provenance|blocked resume|resume preflight|resumes agent with rejection feedback|reviewer context compatibility|validation admission lifecycle ownership|validation execution compatibility

Freeze public bytes/filter, before-manager, original regions, baseline package/script
and six root hashes and actual Node/pnpm/opened SQLite. Retain initial diagnostics
and observed fixture corrections honestly. Restore mocks/env/clocks, close DBs and
release AND join held work in finally. Only private fixture files may be removed.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen assertions/filter, before-source/hashes/runtime and raw results recorded.

Manual: None required for local headless credential compatibility.

## Phase 2: extract and prove resume/persistence contracts

Apply the exact two-product-file recipe and keep public assertions byte-identical.
Add direct tests importing the actual factory, with complete typed pod/profile/launch
fixtures and real provider env/persistence/account helpers for deterministic local
credential cases. Existing module spies may reach rare errors and controlled token/
refresh boundaries; label that scope and introduce no production hook.

Resume matrix:
- Construction without work; exact profile→launch→optional validation-env ordering;
  launch/no-launch, all supported providers and unsupported/null provider skips;
  Foundry absent/mismatch/static/token cases. No-container skips readback/writes but
  preserves applicable env/lineage/capability work.
- Actual OpenAI/Pi rotated JSON, MAX setup-token/nonexpired auth and Foundry static
  key with launch. Foundry token and expiring OAuth paths use existing controlled
  acquisition/refresh boundaries; no external provider/Entra or ambient auth needed.
- Profile-derived owner (including absent owner and divergent pod binding), late map
  get, three warning messages and caught target/helper errors; no new profile re-read
  after held recovery. Actual account reads can still select newly persisted auth.
- Exact builder arguments and conditional binding. Real manager lineage callback
  set/delete behavior stays in manager; direct fixture implements its existing set/
  delete contract and asserts the exact result object and before-write timing.
- Launch/legacy file modes, sequential writes, secret chmod only for legacy, timeout,
  failures on first/later write/chmod; retain earlier account/map effects. Hold work
  to observe ordering, captured profile and late store/factory/service methods.
- Capability call after all writes using original launch; live service replacement/
  removal across awaits; rejection identity and retained prefix; exact env precedence
  with build-env collisions, provider env and final POD_ID.

Persistence matrix:
- Missing pod lookup propagates without warning; missing container returns before
  binding; supported versus unsupported profiles, actual max/openai/pi readback,
  owner from fresh bound profile, original pod.profileName/target and MAX lineage.
- Profile/target/helper failures are swallowed and warned exactly once with original
  {err,podId} and caller message. A logger throw propagates. No added env build,
  auth file write, map write or dispatch. Retain original repository/store/factory/
  map/callback/function identities and late methods.

Use private migrated FILE SQLite with actual pod/task registration, account and
attempt repositories. For actual rotation, assert only the selected account changes,
other account/profile/attempt evidence stays intact, and close/reopen integrity/FK
checks. Trigger a real account credential SQL-update abort and pin its existing
swallowed-warning/old-auth fallback behavior. A later auth write/capability failure
must retain earlier durable account changes and observed lineage prefix. Use only
synthetic fixture credentials. Public checks establish manager-owned lineage/caller
integration; direct callback fixtures prove their narrow collaborator contract.
Do not claim a new transaction or atomic credential/lineage/container update.

### Success criteria

Automated:
- [ ] Frozen public checks pass unchanged after extraction.
- [ ] Direct resume/persistence and real SQLite/account/readback/reopen checks pass.
- [ ] Two-body recipe, ten unchanged callers and two-product/two-test scope pass.

Manual: None required. Live paid providers, Docker and Azure remain outside scope.

## Phase 3: qualify frozen final source

Reuse the task-local Node22.23.3 / pnpm9.15.4 launcher and verify actual runtime and
opened SQLite3.49.2 anew. Freeze final package/script/six root hashes. Retain exact
commands/logs/exits/counts/skips under ignored .autopod-data/worker-runtime-credentials/.
Run supplemental semantic diagnostics over both new test boundaries.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'worker runtime credential compatibility|persists Codex auth.json back|fresh runtime provenance|blocked resume|resume preflight|resumes agent with rejection feedback|reviewer context compatibility|validation admission lifecycle ownership|validation execution compatibility'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/worker-runtime-credentials.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/worker-runtime-credentials.ts packages/daemon/src/pods/worker-runtime-credentials.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 79-suite affected command plus these FIVE distinct
paths without name filters (84 suites):
- src/pods/worker-runtime-credentials.test.ts (new).
- src/providers/credential-refresh.test.ts.
- src/providers/azure-token.test.ts.
- src/configuration/credential-store.test.ts.
- src/configuration/service-credential-boundary.test.ts.

Inherited command: .autopod-data/reviewer-context/affected-command.json. All four
existing additions were verified present/distinct. Record the resolved 84-path
command; reconstruct it from predecessor evidence if the ignored receipt is absent.
Do not substitute a narrower list. Existing env/persistence/account/attempt,
configuration snapshot, isolated-reviewer and runtime suites are already included.

Full qualification includes frozen install, lint, build, supported declaration
typecheck, all tests, audit and secret scan, uncached with SQLite enabled/no new
skips. Retain process-only maintenance.auto=false and root lint's 2 MiB processing
limit only; change no rules/file selection or repository/global configuration.
Preserve/investigate failures before unchanged reruns; known Git metadata-scan race
and audit-clock flake remain outside scope. Slice15's 8,260 tests/35 script tests
are baseline evidence only. No final source changes during qualification. Recheck
exact recipe/diff/hashes; complete actual proof/limits/plan; commit/push verified
increments; confirm remote identity and clean isolated checkout.

### Success criteria

Automated:
- [ ] All 84 affected suites pass with SQLite and no new skips.
- [ ] Full uncached validation passes under the documented qualification environment.
- [ ] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [ ] Complete plan/proof records actual results, limits and final pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests establish worker resume/readback/caller/lineage integration; direct tests
establish helper contracts with real local account persistence and controlled external
interfaces. Existing provider/configuration suites retain their own responsibility.
No performance gain or stronger auth/isolation guarantee is claimed. No migration.
Revert manager composition and the new module together. PR/main/deployment remain
separate work. No unresolved product choice or manual acceptance remains in this plan.

## References and next action

Research: ../research/2026-10-18-pod-manager-worker-runtime-credentials.md.
Predecessor: 2026-10-18-pod-manager-reviewer-context.md (complete).
Source: pod-manager.ts:5036–5224; :3030/:11003; eight persistence callers documented
in research; :3396–3406 lineage callbacks; :1911 validation env;
providers/env-builder.ts; providers/credential-persistence.ts;
providers/credential-refresh.ts; providers/azure-token.ts;
configuration/execution-credentials.ts; pods/continuation-preflight.ts;
pods/provider-attempt-repository.ts and existing manager worker tests.

Next action: user reviews the illustrated plan and explicitly approves all three
implementation phases. No product/test changes or implementation tests in planning.

## Phase 1 observed results

18 new public worker cases and 71 selected existing cases pass against unchanged
product: 89 selected checks, with 1,063 unrelated tests excluded only by this name
filter. Both message and rejection paths prove actual OpenAI/Pi rotation and rewrite
before runtime.resume. Other cases cover legacy skips, MAX secret/chmod ordering,
profile-account drift, missing container/revocation/write failure, processing-error
and kill readback, real SQL update abort, manager-owned MAX lineage set-before-write
and later deletion, and composed launch env/file modes/late capability denial.
Public semantic diagnostics are clean; assertions/filter and before-source are frozen.

Initial fixture diagnostics were preserved: continuation requires 10 GiB (the
fixture now provides 16 GiB); Pi's controlled runtime needs its resume-config methods;
and its second MAX worker turn needs real retry authorization after the first
nonretryable fixture exit. The fixture records a separate human retry authorization
through the actual worker ledger. A failing runtime stream emits its observed start
before throwing. No product correction, suppressed gate or weakened assertion.
Actual Node22.23.3 opens SQLite3.49.2; pnpm9.15.4. Baseline source and six root hashes
are retained under ignored .autopod-data/worker-runtime-credentials/.

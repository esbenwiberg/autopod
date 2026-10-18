# Slice 17: validation environment extraction

Status: APPROVED — Phases 1 and 2 complete; final qualification running.
Date: 2026-10-18.
Baseline: 321ceb07d13f459242289a2f069b49e5e2ddf754.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Move the existing validationEnvironmentForPod helper into an internal module.
It prepares validation build variables and refreshes registry files for validation
and worker resume. Keep credential scope, lookup timing, file order, permissions,
env precedence and failure behavior unchanged.

Continue the established characterize → extract → qualify structure. Approval
covers all three phases together, without intermediate manual gates for this
headless compatibility extraction. Commit/push verified increments per repository
instructions. Planning changes no product or test source. Implementation requires
explicit approval of this plan.

Research: ../research/2026-10-18-pod-manager-validation-environment.md.

## Current state and desired end state

pod-manager.ts is 16,635 lines. validationEnvironmentForPod occupies :1906–1942,
37 lines. Two direct external calls and two existing factory captures use it:
forced revalidation :13871, getValidationEnvironment :14755, worker credentials
:5024 and validation inputs :5121. Those calls/captures and their modules stay intact.

Exactly two product paths change:
- New packages/daemon/src/pods/validation-environment.ts.
- packages/daemon/src/pods/pod-manager.ts: factory import/composition, remove the
  original definition and only buildValidationExecEnv from registry-injector imports.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: append public characterization.
- New packages/daemon/src/pods/validation-environment.test.ts: direct contracts and
  actual local launch/credential persistence checks.

The final module returns the same callback with the same signature. Source-recipe
verification and before/after public assertions establish a compatibility extraction.
It is a small ownership boundary; no performance or stronger security claim is made.

## Implementation approach

Add createValidationEnvironment(deps, captured) with two arguments. Pass the ORIGINAL
manager dependency object through this locally declared narrow live view:

    launchConfiguration?: {
      read(podId: string): EffectiveLaunchConfig | null;
      assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    }

The second argument captures exactly these two current references:

    executionCredentialsFor(config: EffectiveLaunchConfig):
      LaunchExecutionCredentials | undefined;
    containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };

Destructure captured once, preserving object/function identity. Construction performs
no collaborator work. Do not copy/destructure launchConfiguration or cache/bind its
methods. No PodManagerDependencies import or new shared/index export is needed.

Return exactly:

    validationEnvironmentForPod(pod: Pod, profile: PodExecutionSettings):
      Promise<Record<string, string> | undefined>;

Move the COMPLETE original function unchanged, including its internal comment.
Import buildValidationExecEnv from registry-injector, with type imports for Pod,
EffectiveLaunchConfig, LaunchExecutionCredentials, PodExecutionSettings and
ContainerManager. Compose at the original definition site, after the unchanged
executionCredentialsFor declaration and before unchanged injectionsForPod. All
initialization dependencies already exist there. Keep executionCredentialsFor in
manager: five other calls still serve priming, provisioning, deployment and MCP.
Keep LaunchExecutionCredentials imported in manager for its dependency interface.

Verify the parsed TypeScript against the explicit manager/module recipe and exact
original body. Allow only typed factory/dependencies, composition, imports, definition
removal and formatting. Assert two direct external calls and two shorthand captures
remain unchanged, plus the shared resolver body and all its other calls. No receiver
substitution, new checks/catches, cache, clone, helper rewrite or policy correction.

## Compatibility requirements

1. Read launch once. With no launch use the passed profile's registries, null-coalesced
   PAT and buildEnv, and return without credential resolution, checks or writes.
   Do not add a digest error here: callers keep their existing executionForPod checks.
2. With launch, call existing executionCredentialsFor BEFORE the first capability
   await. Missing adapter with admitted references retains its 503 code/message and
   precedes any capability call. Missing adapter with no references retains the
   one-check fallback with profile registries, null PAT and profile buildEnv.
3. With an adapter, call buildEnvironment then registries in the existing Promise.all.
   Keep their receiver and original launch argument; hold the selected adapter across
   the first await, while retaining late method lookups. Start both before awaiting
   completion. Do not serialize, retry or cancel the sibling. Pin synchronous throws
   as well as rejected promises and no writes before both results resolve.
4. Keep original pod/profile references and late pod.containerId/target reads. With
   container, call captured factory.get even for zero files, then write registry.files
   sequentially followed by optional NuGet secret. ALL writes here use mode0600,
   including the NuGet secret. No chmod/chown/install step. Preserve exact failure
   identity and already completed write prefixes; do not roll back.
5. Without container, skip target lookup/writes but retain material resolution,
   final capability check and env return. Final capability check follows all writes.
   Both checks retain late OPTIONAL service-property/method lookups on original deps,
   including replacement/removal across awaits, using the original launch argument.
6. Legacy profile buildEnv keeps its override of telemetry defaults/inferred NuGet
   pointer. Launch returns telemetry defaults + resolved build env + final NuGet
   envFileKey/path override, in that order. Keep absent-secret/empty-material cases.
   A returned path alone does not establish file existence when no container exists.
7. Helper has no catch, logger, pod update, account mutation, status transition,
   snapshot mutation or worker dispatch. Existing callers retain their own handling,
   reserved validation-context overlay, provenance and cleanup. Preserve the actual
   credential helper's current id/createdAt/purpose/origin/rotation behavior without
   moving that authority into this module or adding atomicity/dispatch guarantees.

## Phase 1: characterize public validation environment behavior

Only edit pod-manager.test.ts; append `validation environment compatibility`.
Use current migrated manager context, synthetic local credentials, existing real
launch/configuration fixtures and controlled runtime/container/capability boundaries.
Do not import the future module or add a production testing hook.

Exercise public getValidationEnvironment for legacy profile env/PAT behavior,
launch no-adapter fallback/missing-adapter failure, npm+NuGet files, first/second
capability rejection, no container and exact env precedence. Capture ordered effects
and prove writes precede final check. Test caller context overlay and absence of
validation/runtime dispatch when existing preparation fails. Reuse existing ordinary
validation, forced revalidation and worker sendMessage fixtures rather than changing
those implementations. Add only cases needed to close these specific public gaps;
retain existing caller groups as supporting coverage.

Freeze the appended group bytes and this exact selection before extraction:

    validation environment compatibility|validation inputs compatibility|validation execution compatibility|worker runtime credential compatibility|Path 2: passes profile build env and diff context

Record all selected test names, totals, excluded counts and raw commands/results.
Also run unchanged configuration/components.test.ts before and after as independent
real-composition rotation evidence. Freeze before-manager, original definition,
package/script and six root hashes and actual Node/pnpm/opened SQLite version.
Restore spies/env/clocks, release AND join held work in finally and close private DBs.
Retain failures and any justified fixture corrections without altering product.

### Success criteria

Automated:
- [x] New and selected public tests pass against unchanged product.
- [x] Existing composed rotation test passes unchanged.
- [x] Frozen public bytes/filter, baseline source/hashes/runtime and raw evidence saved.

Manual: None required for the local headless compatibility boundary.

## Phase 2: extract and prove direct contracts

Apply the exact two-product-file recipe; public assertions stay byte-identical.
Add direct tests using the real exported factory and real buildValidationExecEnv.
Use complete typed fixtures and typed controlled collaborators for service timing,
methods/receivers, Promise.all ordering and error identity.

Direct matrix:
- Effect-free construction and same callback contract; legacy null/undefined PAT,
  registries, absent/empty/custom build env and telemetry/NuGet collision precedence.
- Launch missing adapter fallback and exact shared-resolver error via public tests;
  direct callback errors propagate before checks. Capture callback's original config.
- First capability failure stops material lookup; both credential calls start in
  evaluation order, no writes until both finish; either async failure, synchronous
  build/registry throw and sibling settlement retain current behavior. Always join
  held siblings during teardown; no uncontrolled timers or unhandled rejections.
- Empty files, npm only, NuGet only and mixed files; sequential writes all0600,
  target lookup even with zero files, no container, late pod changes across held
  work; lookup and first/later write errors and final check rejection retain prefixes.
- Live service replacement/removal across first check/material/write awaits; original
  launch retained, selected adapter held, late adapter/factory methods retained.
  No second snapshot read or collaborator work added by construction.
- Exact return precedence and original rejection identity for every helper boundary.

Include private migrated FILE SQLite with actual configuration credential store,
launch resolver/snapshot repository and createLaunchExecutionCredentials. Synthetic
npm/NuGet/build credentials resolve from pinned identity; rotate and resolve current
values, revoke and reject, reject wrong purpose/origin, and retain secret-free saved
snapshot. Assert selected credential rows change only during explicit test rotation/
revocation, unrelated credential/profile/pod/attempt rows remain unchanged by env
preparation, and close/reopen integrity/FK checks. Capture actual written material
and mode using controlled ContainerManager; no live registry/network access. Public
composition tests prove wiring to real manager policy; direct callback fixtures prove
only their narrow resolver/capability contracts. Do not invent a transaction or a
new capability fence. No extra production seam or test-only code in product.

### Success criteria

Automated:
- [x] Frozen public tests and unchanged components suite pass after extraction.
- [x] Direct order/env/file/error/timing tests and real SQLite rotation/reopen pass.
- [x] Exact function, full source recipe, four external references and scope pass.

Manual: None required. Live Docker, registry/provider authentication are outside scope.

## Phase 3: qualify frozen final source

Reuse the task-local Node22.23.3/pnpm9.15.4 launcher; recheck actual child runtime
and opened SQLite3.49.2. Retain ignored evidence under
.autopod-data/validation-environment/ with exact commands, logs, exits, names/counts,
skips, movement recipe, before/final manifests and runtime identities. Run scoped
Biome/whitespace and supplemental semantic diagnostics on both new test boundaries.
Freeze package/script and six root hashes before final qualification.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation environment compatibility|validation inputs compatibility|validation execution compatibility|worker runtime credential compatibility|Path 2: passes profile build env and diff context'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/configuration/components.test.ts src/pods/validation-environment.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-environment.ts packages/daemon/src/pods/validation-environment.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run all predecessor 84 affected suites plus exactly these TWO verified-distinct
paths, without name filters (86 total):
- src/pods/validation-environment.test.ts (new).
- src/configuration/components.test.ts (existing).

Inherited exact command:
.autopod-data/worker-runtime-credentials/affected-command.json.
Record resolved 86-suite command; reconstruct from predecessor evidence if absent.
Do not substitute a narrower list. Registry generation, credential store/scope,
snapshot, worker, validation-input/execution and reviewer suites are already included.

Full pipeline includes frozen install, lint, build, supported declaration typecheck,
all tests, audit and secret scan, uncached with SQLite enabled/no new skips. Preserve
only the established process-only maintenance.auto=false and root lint processing
limit --files-max-size=2097152. No lint rules/file selection/config changes. Frozen
install must succeed without fallback or lockfile mutation. Preserve/investigate any
failures before unchanged reruns; known Git metadata race/audit-clock flake remain
outside scope. Slice16 totals (8,358 Vitest +35 standalone script tests,10 existing
gated skips) are prior evidence, not promised final counts.

Do not change source/tests during final qualification. Recheck scope, exact movement
and frozen hashes through documentation-only completion commit. Record actual proof
and limits; commit/push verified increments; confirm clean isolated checkout and
remote identity. Main integration/PR/deploy remain separate work.

### Success criteria

Automated:
- [x] All 86 affected suites pass with SQLite and no newly skipped tests.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [ ] Completed plan/proof has actual results, limits and pushed revision identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove current manager integration; direct tests isolate env/file/order
contracts; real local credential/snapshot/SQLite checks establish rotation and scope
under current collaborators. External providers, Docker/Azure, real package-feed
access, paid calls and deployment remain untested. No stronger atomicity, isolation,
authorization, dispatch fencing, crash recovery or remote completion claim follows.
No API, schema, state, profile, dependency or credential-policy changes. No migration.
Revert manager composition and the new module together. No performance gain claimed.
No unresolved product/design choice or manual acceptance remains in this plan.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-environment.md.
Predecessor: 2026-10-18-pod-manager-worker-runtime-credentials.md (complete).
Source: pod-manager.ts:1893–1942, :5024/:5121/:13871/:14755;
pods/registry-injector.ts; configuration/execution-credentials.ts;
configuration/credential-references.ts; runtime-env.ts;
configuration/components.test.ts; configuration/credential-store.test.ts;
pods/pod-manager.test.ts public compatibility groups.

User approved proceeding with Slice17. Next: characterize unchanged product, extract,
then qualify; all three phases are authorized together.

## Phase 1 observed results

11 new public cases and 77 selected existing cases pass against unchanged product:
88 selected tests; 1075 unrelated cases excluded only by this name filter.
The unchanged composed-service rotation suite passes (one test). New cases pin
legacy fallback, missing-adapter error precedence, npm/NuGet mode0600 writes,
no container, env precedence, first/final capability denial, write failure prefixes
and ordinary validation stopping before diff/engine on preparation failure.
The initial ordinary validation fixture was rejected earlier by existing provider
binding checks; its account/route data now match through actual account resolution.
Initial and corrected results are retained. Product bytes stayed unchanged.
Public assertions/filter and before-source are frozen. Next: extract the approved
single function and run the unchanged public assertions plus direct contracts.

## Phase 2 observed results

createValidationEnvironment contains the complete unchanged original function and
its registry refresh comment. Both direct manager calls, both factory captures,
the shared resolver body and all six resolver calls are unchanged. Parsed TypeScript
matches the explicit manager/module recipe. All 1,975 other baseline package/script
files and six root controls match. The manager is 16,602 lines (33 fewer); the new
module is 69 lines. No product correction followed extraction.

88 frozen public tests pass with byte-identical assertions and identical selected
names/statuses before/after. All 42 direct tests pass, including held parallel lookups,
sequential file effects/errors, live service replacement/removal, original adapter
and late method/pod reads, env precedence, actual encrypted configuration credential
rotation/revocation/scope/identity rejection, secret-free snapshots and private file
SQLite close/reopen integrity/FK checks. Durable rows include a real provider attempt;
unrelated credentials/profile/pod/attempt rows stay unchanged by preparation. Direct
resolver/capability fixtures prove their narrow contracts; the unchanged composed
service test proves real manager wiring and rotation. Container interfaces and
credential enrollment verification remain controlled; no remote execution claim.

The initial direct run exposed a fixture SQL sort on nonexistent provider_attempts.id;
correct ordering is pod_id,ordinal. It was corrected and a real attempt was added so
row preservation is not vacuous. Supplemental type checks identified two absent-field
fixture values outside declared production types; explicit runtime-field fixtures
now exercise absence without changing product types. Initial failures/lint diagnostics
are retained. Both new boundaries have zero supplemental semantic diagnostics;
scoped Biome and whitespace are clean.

All 86 affected suites pass: 3,022 tests, zero skipped, including the unchanged
composed service rotation test. Next: full uncached qualification on frozen source.

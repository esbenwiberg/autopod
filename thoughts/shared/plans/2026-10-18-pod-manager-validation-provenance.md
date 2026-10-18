# Slice 14: validation launch provenance extraction

Status: APPROVED — implementing all three phases after explicit user approval.
Date: 2026-10-18.
Baseline: d2404eb69759c318703f62f5d89e5a1f09136394.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Give validation environment receipts and reviewer launch hooks one module, retaining
current ownership checks, identities, skip projections, record-before-block order and
error boundaries. Use the established characterize → extract → qualify structure.
Approval covers all three phases together; no intermediate manual gate is needed
for this headless compatibility extraction. Commit/push verified increments per the
user's repository instructions. Planning changes no product code.

## Current state and desired boundary

Research: ../research/2026-10-18-pod-manager-validation-provenance.md.
Manager baseline: 17,154 lines. recordValidationProvenance occupies :6476–6556
(81 lines including trailing blank); withReviewerLaunchPreflight occupies :6557–6632
(76 lines). Together they prepare receipts and attach five reviewer hooks.

Both names are injected into createValidationExecution (:5510/:5512). Independent
council handling calls recordValidationProvenance and withReviewerLaunchPreflight
once each (:13560/:13567). The wrapper's container hook calls the recorder internally.
Other coding/recovery preflights stay in manager and keep their original imports.

Exactly two product paths change:
- New packages/daemon/src/pods/validation-provenance.ts.
- packages/daemon/src/pods/pod-manager.ts: import/composition, remove the two
  original definitions and their now-unused imports only.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-provenance.test.ts: direct recorder/hook
  contracts and private file SQLite with actual provenance ledger/preflight helpers.

Manager keeps provider/profile selection, ownership capture/controllers, retry
admission and result policy, actual engine/reviewer dispatch, coding/recovery
preflight, lifecycle/status/readiness, advisory behavior and delivery. Existing
preflight inspectors, model/runtime resolvers, receipt builders, launch-timeout
implementation and ledger remain unchanged. No schema/API/profile/state/dependency,
provider policy, paid request, deployment, new receipt or stronger safety claim.

## Implementation approach

Add createValidationProvenance with three narrow collaborators:

    podRepo: Pick<PodRepository, 'getOrThrow' | 'executionProvenance'>
    containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager }
    resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings

Capture those same objects/function, not an eagerly captured executionProvenance
ledger. Return the two original names/signatures:

    recordValidationProvenance(
      config: Parameters<ValidationEngine['validate']>[0],
      purpose?: 'validation' | 'review',
      assertCurrent?: () => Pod,
      reviewerLaunch?: ReviewerLaunchIdentity,
    ): Promise<void>
    withReviewerLaunchPreflight(
      config: Parameters<ValidationEngine['validate']>[0],
      ownership: ReturnType<typeof captureValidationOwnership>,
    ): Parameters<ValidationEngine['validate']>[0]

Keep the original inner default purpose='validation' and both bodies unchanged,
including recordApiDispatch and all nested callbacks. Factory construction performs
no ledger/profile/container/ownership work. Use original imports for createHash,
inspectExecutionPreflight, TaskRetryBlockedError, runtime/model resolvers and three
reviewer receipt builders. Type-only imports cover infrastructure/types/ownership.

Compose immediately BEFORE createValidationExecution, after createValidationProgress.
Keep both shorthand injections and both external council calls unchanged, with their
existing arguments and awaits. The container hook retains its internal awaited call.

Remove the now-unused manager ReviewerLaunchIdentity import, resolveAnthropicModelId,
resolveContainerReviewer, resolveToolReviewModelId imports and the entire three-name
reviewer-api-provenance import block. Keep inspectExecutionPreflight, createHash and
TaskRetryBlockedError because other manager paths still use them. No other imports
or callers change except formatting. New factory is internal; no shared/index exports.

Compare parsed TypeScript for both entire original bodies (including nested helpers),
complete manager and new module against this explicit recipe. Allow type/imports,
typed factory wrapper/composition, definition removal and formatting only. No receiver
substitution, helper normalization, additional capture or rewritten conditions.
Independently verify one external recorder call, one wrapper call and two unchanged
execution injections; compare the moved internal call through exact body proof.

## Compatibility requirements

1. Recorder defaults to validation. Missing executionProvenance returns before any
   reads, ownership calls, profile resolution or probes. Reviewer dispatch receipt
   hooks instead require the ledger and retain their existing distinct errors.
2. Resolve the same initial pod/profile before inspection. Review uses trusted launch
   runtime when supplied, otherwise the original selected runtime resolver. Keep the
   exact councilOnly/identity/string-runtime predicate and pre-probe rejection.
   Preserve worker versus reviewer identity overlays and fallback model/provider/account.
3. Retain skip projections exactly: force validation on for inspection, remove required
   facts only when facts is skipped and contract exists; blank startCommand only when
   BOTH health and pages are skipped; retain command/workdir/env defaults. Hash the
   ORIGINAL config.contract afterward, not the projected inspection contract.
4. With a supplied assertCurrent, recheck and resolve profile after the inspector
   await, before mutation/record. Record using the original pod id/generation. With no
   callback, retain reliance on the existing ledger's generation validation. Keep
   late ledger lookup, including current behavior if it changes/disappears mid-probe.
5. Append the same launch diagnostic only when launch identity is supplied. Persist
   blocked provenance before throwing. Use first PREFLIGHT_* diagnostic or original
   fallback. Propagate probe/profile/record errors with the same earlier effects.
6. Wrapper returns a shallow copy with five replaced hooks; preserve other fields and
   nested references. It neither invokes nor chains incoming hooks or freezes inputs. Hook
   closures continue reading the ORIGINAL config object; do not switch to the copy.
7. API/legacy callbacks retain their different model resolvers, ownership→profile→model
   check→ledger check→record sequence, exact errors and receipt builders. Host callback
   keeps exact model equality and its own missing-ledger error. Do not infer selected
   account/provider identity for legacy API or host evidence, or conflate surface versions.
8. Container hook checks ownership/profile before launch identity, awaits original
   recorder, then returns the synchronous ownership/profile guard. Keep identity
   comparisons for pod/container/model/runtime and existing default values. Actual
   runner timeout/dispatch fences remain outside this module and unchanged.
9. Preserve captured object/function identities and late method/ledger lookup. Add no
   catch, await, transaction, retry, new dispatch, eager guard or optional chaining.
   Evidence describes preparation; it does not establish remote execution/completion.

## Phase 1: characterize public launch provenance

Only edit pod-manager.test.ts. Append `validation provenance compatibility`, using
public triggerValidation/revalidateSession and existing real migrated SQLite context.
No future-module import or production-only seam. Freeze assertions before extraction.

Cover both entries where reachable: checked validation receipts, blocked preflight
saved before the caller handles denial, skip projection/original contract hash, and
selected/legacy API, host and container hooks attached to the actual engine config.
Pin receipt surface/subject/purpose/model/provider/account, execution/task/generation
identity, engine/agent calls, relevant history/status and original entry differences.

Exercise matching/mismatched dispatch models and each container launch identity
component; verify receipt-before-dispatch and retained synchronous launch guard.
Use synthetic local engine/container seams and existing loopback HTTP/local disposable
CLI fixtures only. Select existing real SDK/CLI tests; no external provider request.

Hold an existing container probe, replace lifecycle/pending decision while it awaits,
release/join in finally and prove no stale reviewer dispatch/receipt overwrites the
replacement. Cover binding/profile failures and ledger record failure through existing
seams; target only relevant records/probes, preserving earlier durable evidence.
Retain selected existing independent council and ownership/execution cases rather than
reimplement their policy. Record actual behavior before freezing expectations.

Close DBs, unsubscribe, restore mocks/env/clocks and release/join held work. Freeze
public bytes, selected filter/names, before-source, actual Node/pnpm/SQLite, baseline
package/script and six root hashes under ignored .autopod-data/validation-provenance/.
Retain initial diagnostics/corrections honestly; no assertion weakening to pass.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen public assertions, before-source/runtime/hashes and raw results recorded.

Manual: None required for this local headless extraction.

## Phase 2: extract and prove recorder/hook contracts

Apply the exact two-product-file recipe; keep public assertions byte-identical.
Add validation-provenance.test.ts importing the actual factory. Use actual existing
inspectExecutionPreflight, resolvers and receipt builders with controlled container
interfaces; do not add a production inspector/clock/provider hook for testing.

Direct recorder matrix:
- Construction has no collaborator effects; missing ledger is the original no-op.
  Exercise default/explicit purpose, assertCurrent versus repo lookup, original pod
  snapshot and captured/late object methods/ledger behavior.
- Validate skip combinations including health-only/pages-only/both, facts projection,
  commands/workdir/env and original contract hash. Use complete typed pod/profile/
  config fixtures; assert arguments observable through actual inspector commands,
  recorded receipt and narrow spies on existing functions where necessary.
- Prepared council and actual launch reviewer identities, runtime/model/provider/account
  overlays/defaults and unsupported/unverified rejection. Keep trusted-launch versus
  selected-runtime behavior exactly; add no consistency validation to the recorder.
- Held probe plus actual ownership/binding changes before/after await: preserve guard
  order and absence of later record. Without a callback, prove real ledger generation
  rejection. Exercise profile/probe/record failures and original exception identity.
- Checked and blocked records with first-PREFLIGHT/fallback reasons and optional launch
  diagnostic. A saved blocked record survives reopen even though the helper rejects.
  Use controlled existing probes to reach diagnostic branches; no inspector replacement.

Direct wrapper matrix:
- Shallow copy, five overridden hooks, unchanged input/nested references and no eager
  work. Verify original-config capture versus returned copy, with current fallbacks.
- Fresh ownership/binding checks and exact selected/legacy resolver/model/error paths;
  missing ledger errors; correct distinct version-2 API/host receipts and null identity
  limits. Preserve ledger object/method replacement timing and synchronous errors.
- Host matching/mismatch and existing evidence handling; container pod/container/model/
  runtime mismatch, verified matching launch, held preflight and returned dispatch guard.
  No actual external provider call; disposal of local CLI/loopback fixtures is bounded.

Use private migrated FILE SQLite with real pod repository/task execution/provenance
ledger and actual captureValidationOwnership. Insert via the repository so task
execution identity is registered. Test actual record persistence/immutability, blocked
prefixes, SQL insert abort, stale generation rejection and close/reopen integrity/FK.
Direct guard tests prove collaborator contracts; public cases prove manager controller,
provider binding and council integration. Do not claim a new atomicity/dispatch proof.

### Success criteria

Automated:
- [ ] Frozen public checks pass unchanged after extraction.
- [ ] Direct recorder/hooks and actual SQLite/ledger/preflight/reopen checks pass.
- [ ] Two-body recipe, unchanged calls/injections and two-product/two-test scope pass.

Manual: None required. Live Docker/Azure/provider execution is outside this slice.

## Phase 3: qualify frozen final source

Use the existing task-local launcher with Node 22.23.3 / pnpm 9.15.4; verify actual
child runtime and opened SQLite anew. Freeze final package/script and six root
hashes. Retain actual commands, raw logs/exits, counts/skips and diagnostics.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation provenance compatibility|provenance|reviewer launch|selected API dispatch|legacy API|independent council|validation admission lifecycle ownership|validation execution compatibility'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-provenance.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-provenance.ts packages/daemon/src/pods/validation-provenance.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 63-suite daemon affected set plus these SEVEN distinct
paths without name filters (70 suites):
- src/pods/validation-provenance.test.ts (new).
- src/pods/execution-preflight.test.ts.
- src/pods/required-command-preflight.test.ts.
- src/validation/container-reviewer-runner.test.ts.
- src/pods/host-reviewer-provenance.integration.test.ts.
- src/providers/llm-client.test.ts.
- src/validation/review-tool-runner.test.ts.

The inherited command is retained in .autopod-data/validation-progress/affected-command.json;
append only these verified distinct paths. If the private receipt is unavailable,
reconstruct its explicit list from predecessor evidence before running. The real
ledger suite is already included; do not invent a standalone ownership test path.
Run supplemental semantic diagnostics on both new test boundaries. Full validation
includes frozen install, lint, build, supported declaration typecheck, all tests,
audit and secret scan with SQLite enabled and no new skips.

Retain process-only maintenance.auto=false and root lint --files-max-size=2097152;
change no global/repository config, rule or file selection. Preserve/investigate
failures before unchanged reruns. Known default Git metadata-scan race and audit-clock
flake stay outside scope. Slice 13's results do not substitute for current execution.
Recheck recipe/diff/hashes, record actual proof/limits, complete plan, commit/push
verified increments and confirm remote identity and clean checkout.

### Success criteria

Automated:
- [ ] All 70 affected suites pass with SQLite and no new skips.
- [ ] Full uncached validation passes under the documented qualification environment.
- [ ] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [ ] Complete plan/proof records actual results, limits and final pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove actual manager engine/council/provider-binding integration; direct
contracts use actual inspector/resolvers/receipt builders and real file SQLite/ledger.
Local HTTP/CLI fixtures prove local receipt-before-dispatch order; receipts remain
preparation evidence with their existing unverified capabilities. No new performance,
atomicity, fencing, crash recovery or remote-execution guarantee is claimed. No
migration. Revert manager composition and new module together. PR, main integration
and deployment remain separate work.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-provenance.md.
Predecessor: 2026-10-18-pod-manager-validation-progress.md (complete).
Sources: pod-manager.ts:6476–6632 and :13560–13567; pods/execution-preflight.ts;
pods/reviewer-api-provenance.ts; pods/execution-provenance-ledger.ts;
interfaces/reviewer-launch.ts; validation/reviewer-launch-preflight.ts;
validation/container-reviewer-runner.ts; providers/llm-client.ts;
validation/review-tool-runner.ts and the existing provenance/launch tests.

Next action: user reviews the illustrated plan and explicitly approves implementation.
No product code changed or implementation tests ran in this planning turn.

## Phase 1 observed results

30 new public cases plus 60 selected existing cases pass against unchanged product
(90 selected total; 1,028 unrelated cases excluded by this selection only). Both
entries cover checked/blocked receipts, three non-container receipt surfaces, four
container identity mismatches and matching guard, held preflight supersession/new
decision, profile/ledger errors and skipped input projection with original contract
hash. Existing SDK loopback/council/ownership/execution cases remain selected.

Initial four failures shared a fixture assumption: selected API sonnet resolves to
claude-sonnet-5-5, while legacy tool review resolves to claude-sonnet-4-6. Fixtures
now pin both actual distinct mappings; one initially unused type alias is used by
the added skip-projection checks. Public semantics are clean. No product changes.

Before source, frozen public bytes/filter, 1,971 baseline package/script hashes, six
root controls and raw logs/exits are retained under .autopod-data/validation-provenance/.
Actual Node 22.23.3 opens SQLite 3.49.2 using the existing pinned pnpm launcher.

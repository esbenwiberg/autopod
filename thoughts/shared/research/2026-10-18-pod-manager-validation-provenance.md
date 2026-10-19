# Slice 14 research: validation and reviewer launch provenance

Date: 2026-10-18 (Europe/Copenhagen).
Researcher: Codex.
Baseline: d2404eb69759c318703f62f5d89e5a1f09136394.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Current boundary

Thirteen slices are complete. pod-manager.ts is 17,154 lines. Its remaining
validation launch-provenance logic lives in two contiguous local helpers:
recordValidationProvenance :6476–6556 (81 lines including trailing blank) and
withReviewerLaunchPreflight :6557–6632 (76 lines including trailing blank).
The latter contains the local recordApiDispatch helper and five installed hooks.

The manager injects both names into createValidationExecution at :5510/:5512.
One external manager call to each helper occurs in independent council handling
at :13560/:13567. The wrapper also calls recordValidationProvenance internally at
:6625 when preparing a container reviewer. Coding/recovery preflight remains in
other manager branches at :9554, :9596 and :9619.

## recordValidationProvenance

The function defaults purpose to validation. Missing podRepo.executionProvenance
returns before pod reads, ownership calls, profile resolution or probes. With a
ledger, it uses assertCurrent() when supplied, otherwise getOrThrow(config.podId),
then resolves the bound profile. It uses a set of config.skipPhases.

For review, runtime is trusted reviewerLaunch.runtime when supplied, otherwise the
existing resolveContainerReviewer on the config's reviewer provider/credentials.
Review requires councilOnly or launch identity plus a string runtime; unsupported
prepared councils throw TaskRetryBlockedError before probing or recording.
A reviewer execution pod overlays runtime/model/provider/account onto the original
snapshot. Validation uses the worker identity. Both force validation on for inspection.

inspectExecutionPreflight receives the selected target manager and config.containerId.
Skip rules remove facts requiredFacts and skip command inputs; startCommand is blank
only when both health and pages are skipped. Workdir/env defaults are retained.
The inspection records purpose/subject, CLI/environment/commands/capability diagnostics.
After its await, a supplied ownership callback and bound-profile resolution run again.
The helper then hashes the ORIGINAL config.contract, optionally appends the reviewer
launch diagnostic, and records with original pod id/generation. Blocked provenance
is recorded BEFORE TaskRetryBlockedError is thrown. The reason is the first
PREFLIGHT_* diagnostic, otherwise the existing generic fallback.

The ledger property is looked up at entry and again at record time; it is not cached.
The helper adds no catch/transaction. The existing real ledger validates lifecycle
identity and receipt surface, creates the immutable execution_provenance row in its
own transaction, and rejects stale generations or SQL errors.

## withReviewerLaunchPreflight

Returns a shallow config copy and replaces five hooks without invoking them:
- assertReviewerCurrent checks ownership and resolves its bound profile.
- Selected and legacy API receipt callbacks check ownership/profile, compare dispatch
  model with their existing DIFFERENT model resolvers, require a ledger, then record
  their corresponding existing receipt. API surface/version-2 receipts do not claim
  a CLI, image, provider response, billing or completion. Legacy identity stays null.
- Host receipt callback checks ownership/profile and exact configured model, requires
  a ledger and records reviewerHostCliProvenance. Host provider/account remain null.
- beforeReviewerLaunch checks ownership/profile, verifies pod/container/model/runtime
  against config and the existing selected runtime resolver, awaits the reviewer
  provenance helper, then returns a synchronous ownership/profile guard for dispatch.

Callbacks capture the ORIGINAL config object even though the returned object is a
shallow copy. Nested references remain shared and callback method/ledger lookups
remain late. No freeze, hook chaining, catches or new provider dispatch occurs here.
The real container runner's prepareReviewerLaunch keeps timeout/remaining-budget
and final synchronous dispatch fencing in validation/reviewer-launch-preflight.ts.

## Imports and collaborators

Runtime collaborators referenced from outer manager scope are podRepo,
containerManagerFactory and resolveEffectiveBoundProfile. Other calls use existing
imported helpers. ReviewerLaunchIdentity and resolveAnthropicModelId,
resolveContainerReviewer, resolveToolReviewModelId plus the three functions from
reviewer-api-provenance.ts have no manager use outside these two definitions.
inspectExecutionPreflight, createHash and TaskRetryBlockedError have other uses and
must remain in the manager. PodRepository exposes optional executionProvenance;
insert registers real task execution identity used by its ledger.

## Existing evidence boundaries

Manager tests around :17490 cover checked/blocked independent reviewer provenance,
:17524 selected API receipts, :17568 real SDK HTTP against a loopback fixture,
:17660 non-container ownership, :17693 launch identity mismatch and :17753 council
preflight/replacement races. The host-reviewer-provenance integration test launches
a disposable local CLI fixture and verifies receipt-before-dispatch and stale replay.
Execution-preflight, required-command-preflight, ledger and container reviewer tests
cover their existing implementations. No external provider is needed for this scope.

The explicit predecessor affected command has 63 suites. Seven verified distinct
additions would yield 70: future pods/validation-provenance.test.ts plus existing
execution-preflight, required-command-preflight, container-reviewer-runner,
host-reviewer-provenance.integration, providers/llm-client and review-tool-runner tests.
The ledger suite is already in the inherited set. No standalone ownership test exists.

No product/test changes or implementation test runs occurred during this planning
turn. Planning continues the established characterize → extract → qualify structure.

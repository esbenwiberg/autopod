# Slice 15 research: reviewer configuration and execution context

Date: 2026-10-18 (Europe/Copenhagen).
Researcher: Codex.
Baseline: 2cdb48e56551f69f235585c9b12316d3e8409eee.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Current boundary

Fourteen slices are complete. The clean rewrite checkout has a 16,995-line
pod-manager.ts. Three contiguous helpers at :5163–5349 coordinate reviewer setup:
buildReviewerExecEnv (:5163–5264, 102 lines including separating blank),
getEffectiveReviewerConfig (:5265–5320, 56 lines) and getReviewerExecutor
(:5321–5349, 29 lines). Their combined region is 187 lines.

The manager passes all three into createValidationInputs (:5484–5487), uses them
in manual revalidation (:14266–14300), exposes existing public reviewer methods
(:14705–14714) and uses config/executor for launch memory (:14719–14726).
The environment helper internally calls the config resolver twice and executor
once; the executor internally calls the config resolver once. Main resume env,
worker credential persistence, provider failover selection and bound-profile
resolution remain separate functions.

## Reviewer configuration

getEffectiveReviewerConfig first reads deps.launchConfiguration at call time.
For an independent launch reviewer it requires provider account storage, validates
the saved route/account with actual assertLaunchAgentAccount, reads current account
credentials, and overlays provider/account/runtime/model/reviewer/reasoning/failover
onto executionForPod(pod). Main-account revocation is not substituted for this
independent account; the existing snapshot integration tests cover that distinction.

For follow-main launches it resolves the current bound profile and reads account
credentials when an account exists, otherwise null. It returns a copied profile
with reviewerModel set to defaultModel. No legacy profile credentials fallback is
added in that branch.

Without a launch projection, ANY existing provider-attempt history selects the
bound-profile path, including closed history. An absent/empty history uses the
existing resolveEffectiveReviewerProfile(pod, executionForPod(pod)), which overlays
only snapshot routing fields onto current execution settings. Account credentials
come from the account store when an account id exists; otherwise profile credentials
are retained. A launch digest with missing credentials throws the existing 409
PROVIDER_CREDENTIALS_MISSING error in this fallback path. Callers may throw earlier
when immutable execution settings are unavailable.

## Executor selection

getReviewerExecutor defaults purpose to review; no launch digest returns undefined
before reading launch configuration. A digest requires both launch and reviewer
service or throws 503 REVIEWER_ISOLATION_REQUIRED. It resolves the effective profile.
An independent reviewer passes its selected route object unchanged. Follow-main
copies the main route, overlaying account/runtime/model/reasoning with nullish
fallbacks from the resolved profile. It calls reviewer.executor with its original
receiver and returns the executor without invoking it. The memory caller supplies
purpose memory. Actual isolated execution, budgets, account/lifecycle checks,
networking, provenance and cleanup remain in validation/isolated-reviewer.ts.

## Legacy environment preparation

buildReviewerExecEnv returns undefined for digest-backed pods after calling
getReviewerExecutor to enforce availability. For other pods it resolves reviewer
profile/credentials first, reads launch again and rejects an independent launch
before legacy environment work. Only max, foundry, openai and pi proceed.

With a container, max/openai/pi recover rotated auth using the existing persistence
helpers. The owner is the POD's providerAccountIdSnapshot, not a newly selected
reviewer profile account. MAX lineage is looked up in the existing map. Recovery
exceptions are warned and swallowed; configuration is re-read afterward even after
that warning. Target-manager lookup before the try still propagates. Foundry skips
recovery. buildProviderEnv receives the refreshed profile/credentials, original pod
runtime and conditional pod binding, plus original profile/account/catalog objects.

The helper writes containerFiles sequentially, then each secret file followed by
chmod 0400 with 5,000 ms timeout. It adds no launch-mode file permissions or
transaction. Write/chmod/build failures propagate with earlier persistence/writes
retained. No container still builds env but writes no files. Return ordering is
{ POD_ID: pod.id, ...result.env }. It does not call rememberMaxCredentialLineage;
adding that call would change existing behavior.

## Capture boundaries and imports

The three bodies reference two late properties of the ORIGINAL manager dependency
object: launchConfiguration and providerAttemptRepo. Other collaborators are the
already captured providerAccountStore, providerCatalog, profileStore,
containerManagerFactory, logger, maxCredentialLineageByPod, executionForPod and
resolveEffectiveBoundProfile. The map/stores/factory retain late method lookups.
A factory can retain the original dependency object through a narrow structural
view and capture those eight existing references, leaving both kinds of lookup
unchanged. Capturing launch/reviewer/attempt values eagerly would differ.

resolveEffectiveReviewerProfile has only this manager use and can move its import.
assertLaunchAgentAccount, buildProviderEnv, all three persistence helpers,
ProviderCredentials and other types still have manager uses and must remain there.
The new module needs no runtime import of pod-manager or new infrastructure seam.

## Existing test boundaries and qualification

Manager tests :5110–5225 cover fallback review/current account credentials and legacy
snapshot selection; :12153–12212 covers actual Codex auth recovery through the public
reviewer env method. Other manager tests cover missing/rebound accounts and provider
history. configuration/pod-snapshot-integration.test.ts :188–266 covers independent
reviewer routing and revocation with actual configuration/snapshot/account stores.
Existing provider env/persistence, account store, provider attempt, runtime resolver,
isolated reviewer and memory reviewer suites cover their implementations.

The predecessor's explicit affected command has 70 suites. Nine distinct additions
were checked against that list: future pods/reviewer-context.test.ts and existing
configuration/pod-snapshot-integration.test.ts, configuration/agent-route-resolution.test.ts,
validation/isolated-reviewer.test.ts, provider-accounts/provider-account-store.test.ts,
pods/provider-attempt-repository.test.ts, providers/env-builder.test.ts,
providers/credential-persistence.test.ts and providers/memory-reviewer.test.ts.
That yields 79 suites. Source and six root controls still match Slice 14's frozen
manifest. No product/test changes or implementation test runs occurred in planning.

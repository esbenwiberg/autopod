# Slice 16 research: worker runtime credentials

Date: 2026-10-18 (Europe/Copenhagen).
Researcher: Codex.
Baseline: b10a505a6c479fec4ea6225ac6c983a386008fd9.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Current boundary

Fifteen slices are complete. The rewrite checkout is clean and pod-manager.ts has
16,820 lines. Worker credential coordination remains in two local helpers:
getResumeEnv (:5036–5162, 127 lines including separating blank) and
persistRuntimeCredentialsForPod (:5175–5224, 50 lines). The newly extracted reviewer
context composition sits BETWEEN them (:5163–5174). These bodies are not contiguous.
The preceding getResumeEnv documentation describes its current provider branches.

getResumeEnv has two external calls: taskFeedbackEvents (:3030) and human-message
resume (:11003). taskFeedbackEvents feeds rejection, override guidance and validation
correction, with fresh worker fallback retaining the same env. The persistence
helper has eight awaited calls: handoff (:7171), normal agent exit (:9667), error
cleanup (:9770), override guidance (:10924), human-message resume (:11046), rejection
(:11937), kill (:12091), validation feedback (:13782). Caller labels/conditions and
lifecycle/provenance fences are outside the helpers.

## Resume environment behavior

getResumeEnv resolves the bound profile first, reads the current launch projection,
and, when present, awaits validationEnvironmentForPod(pod, profile) BEFORE filtering
providers or recovering runtime credentials. Its owner comes from that resolved
profile's providerAccountId, not directly from pod.providerAccountIdSnapshot.

Without a launch, only max/foundry/openai/pi proceed. Legacy Foundry returns
undefined when credentials are absent/mismatched or have a static apiKey; token-auth
proceeds. A launch bypasses those legacy skips, including for other providers and
static-key Foundry.

MAX/OpenAI/Pi with a container call existing credential persistence helpers in
separate try/catch blocks. Target-manager lookup occurs INSIDE those catches.
MAX reads the existing lineage map. Exceptions warn with three distinct original
messages and execution continues. The original bound profile is retained across
awaits; there is no explicit post-recovery bound-profile re-read here. Actual
buildProviderEnv can still read the current account credentials through its options.

buildProviderEnv receives that original profile, pod id, logger, original stores/
catalog, current pod runtime and conditional pod binding. rememberMaxCredentialLineage
runs after its result and BEFORE any auth file writes, even with no container.
That callback sets or deletes the manager-owned map entry. A later write failure
retains its earlier lineage/account effects.

Container files are sequential: launch files get mode0600; legacy files pass
undefined as the fourth argument. Secret files follow: launch writes mode0400 and
continues without chmod; legacy writes without mode then execs chmod0400 with
5,000 ms timeout. After writes, a saved launch triggers a LATE optional lookup of
deps.launchConfiguration and await of its assertCurrentCapabilities(launch).
Removal of the live service can skip that existing optional call. Return order is
{ ...buildEnv, ...result.env, POD_ID: pod.id }; POD_ID wins. Build/write/late capability
failures propagate; no transaction or rollback is introduced.

## Post-run persistence behavior

persistRuntimeCredentialsForPod first gets the pod outside its try. Missing pods
therefore throw. No container returns before profile resolution or logger work.
Inside the try it resolves a fresh bound profile, accepts only max/openai/pi, derives
the owner from that profile, selects its container manager, then awaits the existing
provider-specific persistence helper. MAX receives the current lineage. Profile,
target lookup and provider helper exceptions are swallowed and warned through
logger.warn({err,podId}, logMessage). A thrown logger itself is not caught again.
No build, credential reissue or auth file write is added here.

## References and imports

The only live manager dependency property in these bodies is launchConfiguration,
used through read and assertCurrentCapabilities. Already captured collaborators
are podRepo, providerAccountStore, providerCatalog, profileStore,
containerManagerFactory, logger, maxCredentialLineageByPod,
resolveEffectiveBoundProfile, validationEnvironmentForPod and
rememberMaxCredentialLineage: ten references. Stores/factory/map retain their late
methods; the manager's original dependency object retains late property lookup.

All three persist helpers have no other direct manager use after removing these
bodies; their named imports can move. buildProviderEnv stays in manager for initial
provisioning (:8921); MaxCredentialLineage/ProviderEnvResult stay for the manager's
map and callbacks. remember/forget lineage, provisioning, validation/registry env,
execution credentials, reviewer context and profile/failover authority remain in
manager. The new module needs no runtime or type import of pod-manager.

## Existing evidence boundaries

Manager tests cover Codex persistence after an agent run (:11652), rejection resume
preflight/provenance (:11319 onward), runtime outcomes, kill, error cleanup and
worker recovery. The test named 'recovers and rewrites fresh Codex auth.json for
resume env from provider account' at :12152 actually calls getReviewerExecEnv; it
is reviewer evidence and cannot by itself prove getResumeEnv. Slice15's new tests
also concern reviewer context, so new worker public checks must exercise worker
entry points and actual runtime env/readback boundaries.

Existing provider env/persistence, account/attempt and runtime suites are in the
79-suite inherited affected set. Five distinct additions were verified: future
pods/worker-runtime-credentials.test.ts and existing providers/credential-refresh.test.ts,
providers/azure-token.test.ts, configuration/credential-store.test.ts and
configuration/service-credential-boundary.test.ts. Total planned affected suites:84.
Actual scoped launch credential/registry helpers can be exercised through existing
configuration test fixtures and current manager callbacks. No external OAuth, Entra,
paid provider, Docker or Azure execution is needed for local contract evidence.

Planning changes no product/test source and runs no implementation tests. Source
and six root controls remain frozen against Slice15's final manifest.

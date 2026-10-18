# Slice 22: continuation and native Goal rework

Status: COMPLETE — Slice 22 implemented, locally proven and qualified.
Date: 2026-10-18. Baseline: 2c8bab5c2dacb63de674502de2f6d7e86de33d0c.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-18-pod-manager-continuation-goal-rework.md.

## Objective and authorization

Complete milestone 22, then continue 23–34 under the user's full remaining-slices
instruction. Keep the established characterize → extract → qualify checkpoints.
No API, policy, schema, credential protocol, live/paid execution, PR/main integration
or deployment change. Research and live source agree; no product choice is unresolved.

The manager is 13,833 lines. This outcome moves eighteen complete function bodies
and the REWORK_IN_PROGRESS_PREFIX constant. Mutable recovery maps retain their exact
original objects and construction sites, pending their milestone-31 ownership work;
active-run collection ownership remains milestone 24.

## Concrete boundary

Create five internal product files under packages/daemon/src/pods/:
- continuation-policy.ts exports the existing constant and complete
  sanitizeSecurityReworkValue, buildManualReworkReason and renderPiHandoffFile.
- continuation-context.ts: createContinuationContext returns complete
  appendDecisionContext, buildRecoveryTask, buildContinuationPrompt, buildReworkTask,
  recordContinuationProvenance, beginGoalTaskRework and taskFeedbackEvents.
- provider-continuation.ts: createProviderContinuation returns complete
  visibleProviderHandoffActivity, prepareProviderContinuationHandoff,
  queueProviderContinuation, handleProviderLimit and continueProvider.
- continuation-controls.ts: createContinuationControls returns complete
  resumeNativeGoal, assertCanRework and resumePod.
- continuation-ports.ts declares explicit narrow live dependencies, captured
  collaborators and the three-method resume receiver contract. It imports infrastructure
  types or existing domain factory types, never PodManager/PodManagerDependencies.

Manager changes are imports, three factory compositions/destructurings, original
function/constant removal and four thin public delegates. Existing callers and all
original algorithm bodies/parameters/awaits remain unchanged. Convert public method
syntax to function syntax in owners; resumePod adds only a typed this parameter for
handleCompletion/revalidateSession/approveSession. Delegate with lazy rest-tuple ports
(...args) => this.method(...args), preserving receiver lookup and argument arity.
Other public methods call their owner directly. No extra async wrappers.

All new product owners remain below 1,000 lines. Preserve whole original algorithms,
including callbacks/catches/finally, detached promises, timeout setup/clear, rollback
updates, native session handling and returned action/error shapes.

## Initialization and dependency contract

Compose all three factories immediately after createWorkspaceTransfer's
syncWorkspaceBack/recoverWorktreeFromContainer destructuring (baseline :4264).
At that point provider attempt context, runtime-resume priming, worker resume env,
original maps, cleanup timeout and original captured infra references exist.
Remaining collaborators are original hoisted functions. No service calls occur during
construction. Validation trigger/revalidation capture the new context functions later;
completion decision reads the policy constant through a static import.

Pass the ORIGINAL deps object through this live structural view:
- eventRepo?: Pick<EventRepository, 'getForSession'>
- providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>
- requeueSessionAfterCurrent?: (podId: string) => void
- workerInfrastructureRetryBackoffMs?: readonly number[] (use exact existing
  mutability contract if the infrastructure declaration requires mutable arrays)
- sandboxInfrastructureRetryBackoffMs?: readonly number[]
- launchConfiguration?: read, assertCurrentCapabilities, optional beginGoalRework;
  goals?: Pick<PodGoalService, 'get' | 'prepareResume'>.
Keep original deps lookup expressions intact, including repeated optional lookups.

Captured references are exactly those found by the saved parsed-source analysis,
per factory; no union bag is passed to a factory. The shared ports declare types for:
podRepo (only referenced methods/subservices plus atomically/afterCommit for the
existing unit of work), nudgeRepo.hasPending, worktreeManager.ensureExcludes,
providerAccountStore.get, profileStore.resolveProviderFailover, runtimeRegistry.get,
containerManagerFactory.get, logger.warn/info, executionForPod, enqueueSession,
emitActivityStatus, transition, syncWorkspaceBack, getResumeEnv, primeRuntimeForResume,
resolveEffectiveBoundProfile, profileForProviderTarget, openProviderTargetAttempt,
closeProviderAttempt, selectProviderFailoverTarget, providerFailoverUnavailableActivity,
forgetMaxCredentialLineage, stopSandboxPreviewProxy, stopHaproxyDenyReceiver,
CONTAINER_CLEANUP_TIMEOUT_MS, mcpBaseUrl, assertExecutionTerminationVerified,
assertGuidanceCollected, ownsLifecycle, isRetryableFixDeliveryFailure,
completeFixPodAfterPush, hasDurableAgentExecutionEvidence, pushAndCreatePr,
operatorErrorMessage (agent phase only), activeAgentRuns.has, and the two exact
recovery Map<string, Promise<void>> references. Derive existing domain-function types
from their factory ReturnType where useful; keep manager-local function signatures
explicit. No methods are cached/bound/replaced or optional services eagerly read.

## Phase 1: freeze and reuse the qualified baseline

Verify all 1,995 qualified Slice-21 package/script hashes, six root controls and the
unchanged public test file before editing. Reuse its complete 1,192-case public-after
result only with explicit hash/provenance evidence. Save original manager, definitions,
all references, complete expected extraction recipes and public assertion bytes.

Automated:
- [x] Qualified predecessor manifests and exact public assertions/results match.
- [x] Selected definitions, caller references and initialization sites are recorded.
Manual: none; remaining sequence is authorized together.

## Phase 2: extract and verify the complete boundary

Move all eighteen bodies/parameters and constant intact. Parsed comparison checks
complete manager/module recipes, original bodies/parameters and every retained caller;
normalize formatting only (quotes/trailing commas/type-union layout/type-member
terminators/JSDoc indent). Public assertions stay byte-identical. Add four direct files:
continuation-policy.test.ts, continuation-context.test.ts,
provider-continuation.test.ts and continuation-controls.test.ts.

Direct tests establish:
- Validation/scanner/status rework precedence, sanitized structured metadata and exact
  Pi banner/instructions; appended journal and queued guidance survive task wrapping.
- Current binding/lifecycle/provenance checks before runtime priming; resume versus
  fresh spawn, exact MCP reference, env/session/reasoning/instruction inputs and errors.
- Achieved/stopped native Goal guard, separate Task rework callback effects and saved
  Goal achievement. Native Goal resume revision/lifecycle/budget/after-commit admission.
- Provider handoff exclusion/write order; real bounded handoff file in a private
  worktree; visible event projection. Same/alternate bindings, source session reuse,
  queue ordering, rollback on failed update/transition and original enqueue/defer ports.
- Runtime/sync/kill/timeout fail-closed behavior and timer cleanup; explicit provider
  evidence/hop/policy/worker guards and error identity. Use real local attempts/accounts/
  profiles/pods, controlled runtime/container/worktree/dispatch boundaries.
- Artifact and infrastructure resume coalescing/cleanup, safe sandbox ownership after
  awaited kill, fix/PR/revalidation action selection and lazy receiver dispatch.
- At least three private migrated SQLite file close/reopen cases cover retained
  continuation history/binding, native Goal Task rework and native Goal resume state;
  integrity and FK checks pass and unrelated account/profile data remains unchanged.
- Factory construction is inert; live optional service/method lookups and captured
  reference identity retain original behavior. Existing recovery maps remain shared.

Run the full unchanged 1,192-case manager suite and compare names/statuses/assertion
bytes, all four direct suites, supplemental semantic checks on new test files, scoped
Biome/whitespace and daemon/dependency build/declarations. Preserve initial failures;
fix extraction/fixture faults without changing original algorithm behavior or old
assertions. No live provider/browser/Docker/Azure or paid dispatch.

Automated:
- [x] Eighteen bodies/parameter lists, constant and complete extraction recipes match.
- [x] Unchanged full public manager suite passes with identical names/statuses.
- [x] Four direct suites and three private SQLite reopen cases pass with no new skips.
- [x] Build/declarations, scoped lint/whitespace and new-test semantic checks pass.
Manual: none.

## Phase 3: qualify and continue

Use all 99 inherited affected suites plus the four new direct paths and four existing
recovery-context, feedback-formatter, goal-repository and pod-goal-service suites:
107 distinct unfiltered suites. Resolve the exact inherited command from
.autopod-data/provider-attempt-context/affected-command.json and deduplicate it.
Then freeze source and run the established full uncached command:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use the pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2 task launcher. Frozen install must
pass without fallback/lock mutation. Retain only the established 2 MiB lint processing
limit and process-only Git maintenance override. Preserve source/test/dependency/
config selection. Record actual full/direct/affected counts and the ten inherited
skips. Commit/push source and documentation checkpoints, verify final clean remote
identity and all frozen hashes. Update this plan/roadmap, then begin milestone23.

Automated:
- [x] All 107 affected suites pass, SQLite enabled and no new skips.
- [x] Full frozen uncached pipeline passes; actual counts/limits recorded.
- [x] Scope, frozen source and clean pushed revision match.
- [x] Milestone complete in plan/roadmap; next incomplete scope recorded.
Manual: none.

## Compatibility, rollout and rollback

No migration or behavioral/performance guarantee change. Preserve synchronous/async
boundaries, observed error timing, receiver semantics, credentials, lifecycle fences,
usage/retry accounting and event/side-effect order. Revert the manager and five new
modules together to roll back. Evidence remains ignored under
.autopod-data/continuation-goal-rework/. The milestone-27 validation-trigger delivery/
size review remains required. Full goal completion still requires all Slice-34 gates.

## Phase 2 evidence

All eighteen original function bodies/parameter lists, the constant initializer and
complete explicit manager/module recipes match parsed TypeScript after formatting-only
normalization. All 1,994 other baseline package/script paths, public assertions and six
root controls remain byte-identical. The manager is 12,995 lines (838 fewer). New
modules: policy86, context137, provider477, controls412 and contracts104 lines.
Factory initialization follows existing workspace-transfer composition; original
recovery maps and active-run references retain their identity/construction sites.

The unchanged 1,192-case public suite passes with identical names/statuses. All 50
direct cases pass, including actual runtime provenance with controlled CLI probes,
MCP reference/order, native Goal guards/revision/budget, callback receiver lookup,
provider handoff exclusion/write, drain/timeout/rollback, coalescing cleanup and three
private migrated SQLite close/reopen cases. File cases verify provider binding/history,
separate Task rework retaining Goal achievement and revision-bound native resume
with after-commit enqueue, integrity/FK checks and retained profile/account state.
All 107 affected suites pass 3,551 cases with no skips. Build/declarations, scoped
Biome/whitespace and supplemental semantics on all four new direct files pass.

Initial direct fixtures needed valid scanner enums/fields, the ledger's latest reader,
outer event timestamps, an optional exclusion helper and a copied mock implementation
for awaited probe interception. Sandbox target setup must detach the old fixture
container before changing target, then attach the simulated sandbox. The reopen Task
case now performs its writes through the private file connection before close/reopen.
These are fixture corrections; no original algorithm or public assertion changed.
Initial logs/reports remain retained. Final 2,004 package/script hashes and six root
controls are frozen before full qualification. Node22.23.3/pnpm9.15.4/SQLite3.49.2.

## Phase 3 final qualification

Verdict: PROVEN for this local compatibility extraction. The complete remaining-slices
goal stays active; 12 numbered milestones remain, next Slice 23 provisioning.

| Check | Final result |
|---|---|
| Unchanged manager suite | 1,192 pass; identical names/statuses/assertion bytes |
| Direct contract coverage | 50 pass across four suites; three real private SQLite reopen cases |
| Affected regression | 107 suites; 3,551 cases; no skips |
| Full uncached pipeline | Frozen install, lint, build/declarations, typecheck, tests, audit, secret scan pass |
| Vitest | 8,671 cases in 514 passing files; same 10 inherited gated skips |
| Standalone scripts | 35 pass, zero failures |
| Complete movement | 18 bodies/parameter lists, constant and full explicit recipes match |
| Source integrity | 2,004 package/script hashes and six root controls match frozen source |
| Scoped quality | Clean Biome/whitespace and semantics for all four new direct files |

Tested implementation: 04153ba4f37f33bdb7f57bcd2b3d788dc9550b30. A following documentation-only checkpoint records
completion without changing qualified source. Final clean pushed identity is retained
in ignored .autopod-data/continuation-goal-rework/ after push. Actual full command:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Node22.23.3/pnpm9.15.4 uses real SQLite3.49.2. Build/typecheck/test groups ran uncached;
frozen install needed no fallback or lock mutation. Root lint retains 82 existing
warnings and the established 2 MiB processing limit only. No rules/file selection/
repository/global config change. maintenance.auto=false is process-only.

The manager has 12,995 lines, 838 fewer. Complete prompt/context/provider/control
algorithms now have owners, all below 500 lines, plus 104 lines of explicit contracts.
Original callback/await boundaries, exact-arity lazy receiver dispatch, live deps,
captured references and shared recovery maps remain unchanged. Maps retain original
construction pending Slice 31; active-run state moves in24.

Direct cases exercise actual repositories with synthetic credentials and controlled
execution callbacks. Three private file reopen cases cover continuation history and
binding, separate Task rework retaining native Goal achievement, and native Goal
revision/budget/after-commit resume; integrity/FK/profile/account checks pass. A real
private Git worktree proves exclusion before handoff write. Native runtime execution,
provider/container/worktree/launch callbacks remain controlled. No paid/live provider,
browser, Docker/Azure, stronger atomicity/isolation/authorization/replay, PR/main
integration or deployment claim. No manual gate is outstanding. Initial fixture
diagnostics remain alongside passing evidence. Continue Slice 23 under the full goal.

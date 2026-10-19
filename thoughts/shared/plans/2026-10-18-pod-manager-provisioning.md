# Slice 23: provisioning and prepared execution context

Status: COMPLETE — full frozen qualification passed; remaining goal continues through 34.
Date: 2026-10-18. Baseline: 5f01a4ca6c4fa48ad0c1f09b1fb76820f90d72bb.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-18-pod-manager-provisioning.md.

## Objective, authority and end state

Complete the entire milestone-23 provisioning responsibility, then continue24–34
under the user's remaining-slices instruction. Keep concrete research/plan and the
characterize → extract → qualify checkpoints without repetitive confirmations.
No API, policy, schema, credential protocol, live/paid provider, main integration or
deployment change. No manual gate is needed for this compatibility extraction.

The current manager is 12,995 lines. Move all 140 consecutive preparation statements
inside processPod (:5622–7764), nineteen helper bodies and eight constant bindings.
Helpers alone do not fulfill this outcome. Dispatch/event consumption and the original
surrounding process guard/run-local controls/catch/finally remain assigned24; manager
must ultimately meet the full composition/1,500-line finish gate in33/34.

Each new source module stays below1,000 lines. No replacement provisioning monolith.
The final owner returns an explicit PreparedExecution context or a halted outcome,
so processPod retains its original early-return/finally behavior and dispatch inputs.

## Product boundary and exact source groups

Create internal files in packages/daemon/src/pods/:
- provisioning-materials.ts: static resolveSpecFilePath, dataDir, safeFsSegment,
  materializeSpecContextFiles, ensureSeriesArtifactsDir and normalizeCommitEmail,
  SPEC_CONTEXT_CONTAINER_DIR/POD_ARTIFACTS_CONTAINER_DIR. A factory
  createProvisioningMaterials(execFileAsync) returns original materializeSpecFiles
  and captureDeployBaselineHashes, retaining the exact captured promisified exec
  function. Do not move/duplicate its original top-level initializer (assigned33).
- provisioning-runtime-files.ts: original buildAgentEnvFile,
  repairSandboxAgentHomeOwnership, buildCodeIntelligenceServers; original AGENT_SHIM_PATH,
  AGENT_ENV_PATH, AGENT_SHIM_SCRIPT, SANDBOX_AGENT_HOME_DIRS/FILES and MCP_INIT_PROBE_SCRIPT.
  Re-export all three existing public shim exports from pod-manager.ts unchanged.
- provisioning-image-policy.ts: complete resolvePodSpawnImage, isAcrQualifiedImage
  and verifySandboxWarmImageAccess functions.
- provisioning-sandbox-state.ts: createProvisioningSandboxState(live,captured) returns
  assertSandboxAgentStreamingExecSupported, syncSandboxRuntimeSessionState and
  syncSandboxSeriesHandover. Keep original abort/timeout/error/ownership behavior.
- provisioning-tool-installation.ts: createProvisioningToolInstallation captures only
  logger and returns original installGhBinary/installAzViaPip. Existing installTools
  remains the caller; tests execute no download/install command.
- provisioning-workspace.ts: createProvisioningWorkspace prepares the original 27
  statements :5622–6142 (capability/cooldown/binding, human handoff/worker activation,
  recovery flags/worktree/spec/start SHA/baseline, retry/PIM/provisioning/credentials/scan).
- provisioning-container.ts: createProvisioningContainer prepares the original46
  statements :6145–6523 (backend/network/registry/sidecars/reference staging/image,
  state/spec mounts/spawn/deny receiver).
- provisioning-workspace-population.ts: createProvisioningWorkspacePopulation runs
  the original seven statements :6530–6952 (workspace/Git/handoff/author/references,
  running transition and fix feedback).
- provisioning-session-materials.ts: createProvisioningSessionMaterials runs the nine
  statements :6955–7287 (shared skills/registry/hook followed by interactive-only
  exports/MCP/docs/PIM and its finishStartup/return).
- provisioning-agent-materials.ts: createProvisioningAgentMaterials runs the original51
  statements :7290–7764 (automatic MCP/probes/stub repair/actions/sections/provider
  material/ownership/shims/memory/instructions/tokens/registry/repository preparation).
- provisioning-workflow.ts composes those five stages in exactly that order and
  returns {kind:'halted'} or {kind:'ready',prepared:PreparedExecution}.
- provisioning-ports.ts: explicit domain infrastructure/function types, original live
  dependency views, run controls and PreparedExecution. Intermediate stage types may
  derive from the preceding factory's narrowed ready result; they do not expose a
  manager/dependency bag or re-resolve data between stages.

## Data, state and allowed recipe transformations

PreparedExecution contains current pod and launchConfig plus the thirteen original
later-used declarations: containerManager, containerId, profile,
isFreshContainerValidationOnly, isRecovery, isInfrastructureRecovery, isRework,
systemInstructions, secretEnv, worktreePath, mcpServers, reasoningEffort, providerResult.
Keep exact references; no serialization, cloning, re-resolution or caching of services.
Intermediate outputs carry only required original values, preserving updated pod,
launchConfig and profile identities after activation/transition/feedback.

Keep initial processPod guard, lifecycle/attempt capture, setup failure phase, observed
runtime flag, finishStartup/emitStatus/assertStartupCurrent callbacks and archive Set
construction unchanged. A per-run controls object exposes the SAME startupAdmission
slot via getter/setter plus exact callbacks/Set. Only original selected references to
startupAdmission become controls.startupAdmission inside the workspace stage. This
preserves admission/timestamp visibility to the outer catch/finally on thrown stages.
The existing catch re-reads pod before its first read and never uses launchConfig;
verify that fact in the saved source comparison. On ready return assign current
pod/launchConfig and destructure the thirteen fields before existing dispatch code.

Move complete selected statements in order. Only scaffolding transformations allowed:
- original process-scoped inputs become stage parameter/destructuring data;
- original process-level preparation returns become {kind:'halted'} outcomes (do not
  touch returns in nested callbacks/functions); workflow/manager propagate that halt;
- startupAdmission references use the shared accessor port;
- exported helper/factory/import/type/composition scaffolding and unchanged shim re-exports.
All other statement tokens, callbacks, catches/finally, original awaits, branches,
errors, updates, modes, argument order/arity and effects remain unchanged.

New stage awaits add orchestration promise boundaries. Do not add/reorder policy
checks to compensate. Characterize lifecycle/ownership and error-handler behavior
around those boundaries, compare exact permitted recipes and preserve old public
assertions. Document the additional boundaries honestly rather than claiming the
entire processPod body remains byte-identical.

## Captured/live dependencies and construction

Retain original deps lookups as live structural service views for only accessed
launch/retry/provider-attempt/history/auth/actions/memory/token/secret properties.
Record exact keys and original interface types in the generated recipe. Capture only
actual lexical references for each stage/factory, using explicit Pick contracts or
original infrastructure types where an existing helper requires a complete interface
(e.g. history exporter pod repo, provider preflight profile/account stores). Never
import PodManager/PodManagerDependencies in the new domain owners.

Saved AST analysis lists actual inputs/references per stage, including shorthand
value symbols. Interfaces retain original receivers and late optional method reads.
Use existing domain factory ReturnType for captured functions where useful. Original
execFileAsync is captured as typeof execFile.__promisify__, not re-promisified.

Construct sandbox-state/material/tool factories after the manager's initial dependency
destructuring; their dependencies are already initialized and constructors do no
service calls. Static code-intel definitions remain available before runtime-resume
composition (:2023); series handover must exist before completion-source composition
(:4030). Compose provisioning workflow before the public object, after existing
worker credentials/workspace transfer and other captured factory outputs. No startup
service invocation occurs during construction.

## Phase 1: qualified baseline and exact characterization

Verify all2,004 qualified Slice22 package/script hashes and six root controls before
editing. Reuse its unchanged 1,192-case public-after report only with explicit hash/
provenance evidence; freeze the entire public file. Save full manager/process source,
all nineteen helper definitions/eight bindings, exact140 statements, cross-stage
symbols, original references and permitted full extraction recipes.

Automated:
- [x] Predecessor manifests/public assertion bytes and qualified result match.
- [x] Full helper/binding/stage inventory, inputs and catch/finally relationships saved.
Manual: none; the remaining sequence is authorized together.

## Phase 2: implement and qualify the full provisioning boundary

Implement all twelve modules and manager composition as specified. Add focused direct
coverage in provisioning-policy.test.ts (materials/runtime files/image),
provisioning-sandbox-state.test.ts, provisioning-tool-installation.test.ts, five stage
.test.ts files corresponding to the names above, and provisioning-workflow.test.ts.
Use a shared test-utils/provisioning-helpers.ts fixture as needed, built on existing
mock-helpers infrastructure and actual migrated repositories. Do not alter existing
public assertions or unrelated test helpers.

Prove path containment/spec byte preservation/commit selection, image guards and error
identity, shim modes/env quoting and code-intel definitions; session sync ownership/
timeout abort/cleanup, series handover paths and tool-install failures. Stage tests
cover original sidecar/reference/main-container cleanup order, protected workspace/Git
restoration and handoff, late dependencies, captured references, credentials/MCP /
instructions/registry inputs, interactive early exit before automatic material, and
prepared dispatch references. Prove shared admission visibility on thrown stages and
existing catch/finally settlement through the public manager. At least three private
SQLite file close/reopen cases verify startup admission/history, prepared binding/
profile state and interactive/failed startup recovery, with integrity/FK checks and
unrelated row preservation. Private local Git/filesystem cases prove spec/handoff/
archive behavior where practical. Provider/container/launch execution is controlled;
no paid/live model, browser, Docker/Azure, PIM or tool installation.

Run the unchanged full public suite, all new direct suites, new-test semantic checks,
scoped Biome/whitespace and daemon/dependency build/declarations. Parsed audits must
compare all nineteen complete helper bodies/parameters, eight initializers, all140
selected original statements with ONLY the documented transformations, and complete
manager/module recipes. Verify all source outside scope and public assertions frozen.
Preserve initial failures and correct scaffolding/fixtures without original-policy edits.

Automated:
- [x] Nineteen helpers/eight bindings and140-statement recipes preserve allowed changes.
- [x] Full public manager suite passes with identical1,192 names/statuses/assertions.
- [x] Direct stage/helper/workflow cases and three private file SQLite cases pass.
- [x] Build/declarations, scoped lint/whitespace and supplemental test semantics pass.
- [x] No provisioning algorithm remains inline in processPod; prepared context feeds dispatch.
Manual: none.

## Phase 3: frozen qualification and continuation

Run all107 inherited affected suites plus the nine new direct paths, agent-shim and
all existing provisioning collaborators (reference/registry/skill/section/provider/
container/network/sidecar/image/prepare-launch suites), deduplicated and unfiltered.
Record the exact command and actual suite/test counts before the full run. Freeze
source and run the established pinned pipeline:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable task-local npx launcher, only existing
2 MiB root-lint processing limit, frozen install without fallback/lock mutation,
uncached groups, same inherited skips. No dependency/rule/selection/config changes.
Record actual counts and limitations; commit/push checkpoints and verify final clean
remote identity/hashes. Update this plan and roadmap, then start24. Full goal remains
active through34, including the outstanding Slice27 trigger delivery/size review.

Automated:
- [x] Full affected set passes, SQLite enabled and no new skips.
- [x] Full frozen uncached pipeline passes; counts/environment/limitations recorded.
- [x] Source scope and frozen hashes match a clean pushed revision.
- [x] Plan/roadmap complete this milestone and retain next incomplete work.
Manual: none.

## Compatibility and rollback

No migration or new behavior/performance/security guarantee. Retain public shim exports,
credential/account boundaries, original event/order/error semantics and mutable state
ownership. Revert manager and all new modules together to roll back. Evidence stays
ignored under .autopod-data/provisioning/. Remaining process dispatch/error/resource
owners and final architecture gates stay required; this is not whole-goal completion.

## Implementation checkpoint (before full qualification)

The complete boundary is implemented: 19 unchanged helper bodies, eight unchanged
constant initializers and all 140 ordered statements are anchored to the original
AST and match the documented transformations. All thirteen complete file recipes
match; 2,003 other baseline package/script files and six root controls are unchanged.
Manager: 12,995 → 10,296 lines; the twelve new source owners are 65–605 lines.

The unchanged 1,192-case public suite has identical names/statuses and frozen bytes.
All 37 new direct cases across nine suites pass, including three actual private-file
SQLite close/reopen cases, local Git/spec operations, shared startup admission on
throw, sidecar and reference-worktree failure cleanup, interactive shared materials,
workspace Git failures and local/sandbox credential modes. Container/provider commands
are controlled mocks. No live Docker/Azure/provider acceptance is claimed.

Daemon/dependency build and declarations pass, scoped Biome passes without warnings,
and all ten new test/fixture files have zero supplemental semantic diagnostics.
A stronger source semantic audit finds seven diagnostics already present in the
original manager; an exact code/message comparison proves no new diagnostics. These
inherited nullable provider/worktree, template and skill-predicate diagnostics are
retained under compatibility scope; the repository build/declaration checks pass.

Evidence: .autopod-data/provisioning/ (movement.json, public-comparison.json,
public-after.json, packages/daemon/.autopod-data/provisioning/direct-final.json,
baseline-type-comparison.json and named command logs/exits). The affected/full frozen
pipeline and pushed revision checks remain required before this slice is complete.

## Final qualification — 2026-10-19

Implementation: 38d70d53bf437e7920e92569a39143ddeae21c13 (pushed).
Verdict: PROVEN for this local compatibility extraction. Evidence:
.autopod-data/provisioning/proof.json and retained named logs/reports/scripts.

- All 137 selected affected suites passed: 3,991 passing tests and three unchanged
  infrastructure-gated skips in expanded container/reference collaborators. Those
  skips are also included in the ten inherited full-suite skips below.
- The full frozen uncached pipeline passed: frozen install without fallback or lock
  change, lint, build/declarations, repository typecheck, all workspace tests, audit
  and secret scan. 8,708 Vitest tests passed across 523 passing files; the same ten
  gated tests/five wholly skipped files remain. All 35 Node script tests passed.
- Actual runtime: Node 22.23.3, pnpm 9.15.4, SQLite 3.49.2. All 15 Turbo tasks were
  uncached. Task-local launcher is executable; the inherited 2 MiB root-lint file
  processing limit and 82 existing warnings are unchanged. No lint rules disabled.
- All 2,026 final package/script hashes, six root controls and frozen public assertion
  bytes match after qualification. AST proof covers all nineteen complete helpers,
  eight initializers, all 140 ordered statements and thirteen complete file recipes.
- All 37 direct cases and three private-file SQLite reopen cases passed. New test/
  fixture semantics have zero diagnostics. The seven inherited source diagnostics
  described above remain; no new supplemental source diagnostic was introduced.

The twelve provisioning owners remain below 1,000 lines (largest: 605). The manager
is 10,296 lines; this completes only milestone 23. Eleven milestones remain (24–34).
Next: agent dispatch/event consumption, active-run ownership and terminal accounting.
Slice 27's inline trigger/revalidation delivery/size review remains required. No live
provider/Docker/Azure acceptance, integration, PR/main merge or deployment is claimed.

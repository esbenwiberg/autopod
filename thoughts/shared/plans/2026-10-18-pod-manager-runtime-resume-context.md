# Slice 18: runtime resume context extraction

Status: APPROVED — implementing all three phases after explicit user approval.
Date: 2026-10-18.
Baseline: f09e687bc338aac1c10bff80d88315a8b02e74c8.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Move primeRuntimeForResume into one internal module. This helper rebuilds the MCP
configuration and primes existing runtime session/config setters for the next turn.
Keep Goal handling, capability checks, token timing, server ordering/proxy routing,
reasoning selection, setter behavior and failure propagation intact.

Continue the established characterize → extract → qualify structure. Approval covers
all three phases together without intermediate manual gates for this headless
compatibility extraction. Commit/push verified increments per repository instructions.
Planning changes no product/test source. Implementation starts after explicit approval.

Research: ../research/2026-10-18-pod-manager-runtime-resume-context.md.

## Current state and desired boundary

pod-manager.ts is 16,602 lines. primeRuntimeForResume occupies :3012–3100 (89 lines).
Three external awaited calls remain unchanged: task feedback :2995, Pi crash recovery
:9377, human message :10796. Their admission/provenance, fresh-vs-resume choice,
missing-session fallback, actual dispatch and cleanup stay in manager.

Exactly two product paths change:
- New packages/daemon/src/pods/runtime-resume-context.ts.
- packages/daemon/src/pods/pod-manager.ts: factory import/composition, remove the
  original primeRuntimeForResume definition. No existing named import is removed;
  current runtime types, merger, code-intelligence and other helpers still have users.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: append public characterization.
- New packages/daemon/src/pods/runtime-resume-context.test.ts: direct contracts and
  local token/launch-credential/snapshot integration checks.

No state, profile, API, schema, dependency, runtime protocol or credential policy
changes. Do not move taskFeedbackEvents, initial Claude/Codex recovery blocks,
executionForPod/executionCredentialsFor/injectionsForPod, reasoning helpers,
buildCodeIntelligenceServers, getResumeEnv, continuation provenance or dispatch.
This slice builds config; it does not establish live MCP connections or execution.

## Implementation approach

Add createRuntimeResumeContext(deps, captured). Pass the ORIGINAL manager dependency
object through this narrow locally declared live view:

    launchConfiguration?: {
      read(podId: string): EffectiveLaunchConfig | null;
      assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    };
    sessionTokenIssuer?: { generate(podId: string): string };

Capture exactly these SIX existing references/values, under original names:

    executionForPod(pod: Pod): PodExecutionSettings;
    executionCredentialsFor(config: EffectiveLaunchConfig): LaunchExecutionCredentials | undefined;
    injectionsForPod(pod: Pod): { mcpServers: InjectedMcpServer[] };
    mcpBaseUrl: string;
    buildCodeIntelligenceServers(profile: PodExecutionSettings): StdioInjectedMcpServer[];
    resolvedReasoningEffort(profile: PodExecutionSettings,
      snapshot?: Record<string, unknown> | null): ReasoningEffort;

Destructure captured once. Keep live launch/token property and method lookups on
original deps; do not copy, bind, cache or normalize those services. Construction
performs no collaborator work. Return exactly:

    primeRuntimeForResume(pod: Pod, runtime: Runtime, containerId: string,
      env: Record<string, string> | undefined): Promise<McpServerConfig[]>;

Move the COMPLETE original function unchanged, including casts, awaits, conditional
property spreads and exact object keys. Use AutopodError from shared and the existing
mergeMcpServers from injection-merger; infrastructure/runtime references are type
imports. No PodManagerDependencies import, shared export or production testing seam.
Compose at the original definition site, immediately after unchanged taskFeedbackEvents
and before unchanged syncSandboxRuntimeSessionState. Earlier declarations plus the
hoisted top-level code-intelligence helper are available there. Do not invoke the
callback during construction; taskFeedbackEvents' earlier declaration remains safe.

Verify parsed TypeScript against the complete explicit manager/module recipe,
unchanged original body and all THREE awaited external calls. Preserve each caller's
condition, argument, return handling and surrounding inline recovery. Allow only the
typed factory/dependencies, import/composition, definition removal and formatting.
No helper rewrite, receiver substitution, clone, new catch/check or policy correction.

## Compatibility requirements

1. Resolve execution profile before launch read. Goal rejection keeps its exact
   409 code/message before material/token/setters. Launch check1 precedes resolver
   and optional agent material; no launch skips those effects. Preserve shared
   missing-adapter behavior. Initial profile is retained across awaits and material
   shallowly overlays it. Material.buildEnv must not replace the supplied Pi env.
2. Generate token after agent material, through live optional issuer lookup with
   original receiver and pod id. Truthy token creates the same bearer header object
   shared by escalation and HTTP proxy entries. No issuer/empty token retains
   explicit headers:undefined. Preserve token/read/resolver failure identity/timing.
3. Array order stays escalation → merged non-stdio HTTP → code-intelligence stdio →
   launch-only configured stdio. Keep profile-over-daemon name override and existing
   insertion order, including collisions across later categories. Proxy HTTP names
   via encodeURIComponent, using daemon URLs/token headers, not remote headers.
   Keep legacy configured stdio omission and launch configured stdio inclusion.
4. Preserve conditional code-intelligence args/env spreads versus launch stdio's
   explicit args/env keys. Do not normalize absent properties, deduplicate names,
   mutate input arrays/configs, add server checks or change proxy/token policy.
5. Launch check2 follows server construction and precedes reasoning/setters. Retain
   optional LIVE service lookup/replacement/removal across awaits and original launch
   argument. Token already generated before a late denial remains generated. Keep
   original pod/profile/env reads and references; no clone/re-read is introduced.
6. Call existing reasoning resolver with selected profile and current snapshot using
   original cast. Its snapshot > profile > auto behavior remains manager-owned.
   Pi session id is conditional/truthy, config setter mandatory; exact empty task,
   resume instructions, model, /workspace, container, env??{} and MCP list remain.
   Claude guards only config-setter presence, session setter stays conditional but
   unchecked; Codex guards config setter and sets no session id here. Copilot and
   absent guarded setters return MCP config. Preserve missing-method errors and
   earlier setter effects if later setters fail; do not add fallback or rollback.
7. Return the same list passed to setters. The helper does not call runtime spawn/
   resume, perform container I/O, change DB/lifecycle or redo provenance. Callers keep
   those responsibilities. Initial Claude/Codex recovery uses separate inline setup;
   characterize the actual Pi recovery call without misattributing those other paths.

## Phase 1: characterize actual public callers

Only edit pod-manager.test.ts. Append `runtime resume context compatibility`.
Use existing migrated manager/account/configuration fixtures, controlled runtime/
container interfaces and synthetic credentials. No future-module import or product
hook. Reuse the working worker continuation fixture patterns and correct account/
route bindings, rather than bypassing existing preflight/ledger requirements.

Pin public human-message and rejection/task-feedback setup before actual resume,
fresh feedback spawn using returned MCP list where existing entry points permit,
and actual Pi processPod crash-recovery priming. Cover Claude/Codex/Pi setters,
session-id truthiness, snapshot reasoning, legacy HTTP proxy/token behavior and
launch stdio material with capability rejection stopping dispatch. Assert identical
MCP list identity/values at the setter/dispatch boundary where observable. Existing
inline Claude/Codex recovery tests remain regression evidence for their separate paths.
Close only gaps needed for this boundary; retain existing worker/provenance groups.

Freeze appended group/full public bytes and this exact selected filter before moving:

    runtime resume context compatibility|worker runtime credential compatibility|fresh runtime provenance|blocked resume|resume preflight|preserves snapshotted reasoning effort in durable Pi resume config|rehydrates Codex resume config during crash recovery|rehydrates Claude

Record actual selected names/results/excluded counts; do not infer coverage from test
titles alone. Freeze before-manager, complete original definition, package/script and
six root hashes plus actual child Node/pnpm/opened SQLite versions. Restore mocks/
clocks/env, release AND join held work in finally and close private DBs. Retain initial
failures and justified fixture corrections. Product source must remain unchanged.

### Success criteria

Automated:
- [x] New public and selected existing checks pass on unchanged product.
- [x] Frozen assertions/filter, actual selected names, source/hashes/runtime saved.

Manual: None required for local headless preparation compatibility.

## Phase 2: extract and prove configuration/setter contracts

Apply exact two-product-file recipe; frozen public assertions remain byte-identical.
Test actual factory/merge helper with complete typed fixtures. Controlled typed runtime
objects expose only existing setters/interfaces, with no new production hook.

Direct matrix:
- Effect-free construction; exact profile → launch → Goal/check1 → optional resolver/
  agent → token → injections/merge/code-intelligence → check2 → reasoning → setters.
  Legacy/no-launch, no material, no adapter via actual public resolver and callback
  error cases. Profile/material shallow merge and original env reference/default.
- Token absent/empty/present, live issuer replacement/removal during held material,
  exact issuer receiver/id, same header reference and explicit undefined properties.
- HTTP name override/order, encoded names, untrusted remote URL/header not forwarded
  as direct runtime connections, stdio omission/inclusion, code-intelligence mapping,
  cross-category name collisions and exact conditional/explicit args/env key presence.
- Capability rejection before material and after config, original launch across held
  work, live service replacement/removal, captured functions/base URL and late method/
  pod/profile/snapshot reads. Original errors propagate and retain completed prefixes.
- Claude/Pi truthy/empty/absent session ids, mandatory/guarded/missing setters, Codex/
  Copilot behavior, reasoning callback arguments/actual public precedence, exact Pi
  config keys and same returned-array reference. First/later setter failure preserves
  already performed effects; no spawn/resume/abort/container/pod mutation by factory.

Include real local createPodTokenIssuer with a private synthetic key to verify the
returned bearer belongs to the pod. Include private migrated FILE SQLite with actual
launch resolver/snapshot and createLaunchExecutionCredentials.agent: materialize scoped
stdio env, rotate/revoke a synthetic credential, preserve snapshot/other credential/
profile/pod/attempt rows through preparation and close/reopen integrity/FK. Keep a real
nonempty provider attempt so its invariant is meaningful. Capability and runtime setter
boundaries remain controlled. Existing actual runtime suites establish their stored
resume-state behavior; direct typed mocks establish only setter contracts. No paid
provider/MCP/registry traffic, real runtime subprocess or new authorization claim.

### Success criteria

Automated:
- [ ] Frozen public checks pass unchanged after extraction.
- [ ] Direct config/order/token/setter/error/timing and real local SQLite checks pass.
- [ ] Exact original body, all three callers, full recipe and source scope pass.

Manual: None required. Live providers/containers/MCP and deployment are outside scope.

## Phase 3: qualify frozen final source

Reuse task-local Node22.23.3/pnpm9.15.4; verify actual child/opened SQLite3.49.2.
Save exact commands/logs/exits/names/counts/skips and original/final recipes/manifests
under ignored .autopod-data/runtime-resume-context/. Run supplemental semantic checks
on both new test boundaries. Freeze all package/script and six root hashes before
final qualification; no source/test edits during that qualification.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'runtime resume context compatibility|worker runtime credential compatibility|fresh runtime provenance|blocked resume|resume preflight|preserves snapshotted reasoning effort in durable Pi resume config|rehydrates Codex resume config during crash recovery|rehydrates Claude'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/runtime-resume-context.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/runtime-resume-context.ts packages/daemon/src/pods/runtime-resume-context.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run all predecessor 86 affected suites plus these SIX verified-distinct paths,
without name filters (92 total):
- src/pods/runtime-resume-context.test.ts (new).
- src/runtimes/claude-runtime.test.ts.
- src/runtimes/codex-runtime.test.ts.
- src/runtimes/pi-runtime.test.ts.
- src/pods/injection-merger.test.ts.
- src/crypto/pod-tokens.test.ts.

Inherited exact command: .autopod-data/validation-environment/affected-command.json.
Record the resolved 92-suite command; reconstruct from predecessor evidence if absent.
Do not substitute a narrower list. Existing worker/configuration/provenance/validation
suites remain included. Full uncached pipeline covers frozen install, lint, build,
supported declaration typecheck, all tests, audit and secret scan, SQLite enabled.
No new skips. Slice17's 8,411 Vitest/35 script tests and 10 gated skips are baseline
evidence, not new results. Frozen install must succeed without fallback/lock mutation.

Preserve only the process-only maintenance.auto=false and root lint processing limit
--files-max-size=2097152. No rules/file selection/global/repository config changes.
Preserve/investigate failures before unchanged reruns; known unrelated metadata-scan
race/audit-clock flake remain outside scope. Recheck movement/scope/hashes, record
actual proof and limits, commit/push verified increments and confirm clean checkout/
remote identity. Final documentation-only commit must retain qualified source bytes.

### Success criteria

Automated:
- [ ] All 92 affected suites pass with SQLite and no newly skipped tests.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint/whitespace/types, exact movement and frozen hashes pass.
- [ ] Completed plan/proof records actual results, limits and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove actual manager entry-point wiring; direct tests isolate the config
and setter contract. Real local crypto/configuration/SQLite checks prove the stated
local boundaries. Existing runtime tests retain responsibility for their own local
stored-state/invocation behavior. No faster execution, stronger authorization,
atomicity, isolation, dispatch fencing, replay/crash safety or remote completion
claim. No migration. Revert manager composition and new module together. PR/main/
deployment remain separate. No unresolved design choice or manual acceptance.

## References and next action

Research: ../research/2026-10-18-pod-manager-runtime-resume-context.md.
Predecessor: 2026-10-18-pod-manager-validation-environment.md (complete).
Source: pod-manager.ts:3012–3100, :2995/:9377/:10796; :2065/:1911/:16547;
pods/injection-merger.ts; crypto/pod-tokens.ts; configuration/execution-credentials.ts;
runtimes/claude-runtime.ts:327, codex-runtime.ts:501, pi-runtime.ts:119;
pod-manager.test.ts:19401; existing runtime/injection/token suites.

User approved all three phases. Next: characterize unchanged product, extract,
and qualify frozen final source.

## Phase 1 observed results

12 new public caller checks and 24 selected existing checks pass on unchanged
product (36 selected; 1139 unrelated cases excluded only by this filter).
They pin message/rejection Claude/Codex/Pi setters before dispatch, exact proxy/token
configuration and snapshot reasoning, falsey Pi ids, actual Pi processPod recovery,
launch stdio/check2 denial and fresh task-feedback spawn using the exact primed MCP
array after achieved Goal rework. Fresh rework uses real local Goal rows/service and
a controlled existing rework capability on the sandbox branch; it does not establish
native Goal authorization/execution. Separate inline Claude/Codex recovery tests retain
their separate scope. Product bytes are unchanged; public bytes/filter/names are frozen.

Initial launch fixtures incorrectly retained the legacy launch marker and expected a
swallowed capability error. Explicit fixture SQL now seeds the immutable marker
(PodUpdates deliberately does not allow it), and tests assert the original propagated
denial. Typed issuer/daemon fixtures were completed. Initial fresh feedback correctly
hit the local immutable-network-policy restriction; the sandbox caller branch now
exercises fresh spawn without bypassing that policy. Initial diagnostics are retained.
Node22.23.3/pnpm9.15.4 opens SQLite3.49.2; new public semantic diagnostics are zero.
Next: extract the approved function and verify unchanged public assertions plus direct
config, token, credential and runtime-setter contracts.

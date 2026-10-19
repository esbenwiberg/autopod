---
date: 2026-10-18T23:35:48+02:00
researcher: Codex
git_commit: 3fe37cd83168ee6a23377877f6b119d1eefbd2c0
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 23: provisioning and prepared execution context"
tags: [research, codebase, pod-manager, provisioning]
status: complete
last_updated: 2026-10-18
last_updated_by: Codex
---

# Slice 23 research: provisioning and prepared execution context

## Research question and baseline

Locate the provisioning responsibilities assigned to milestone 23 of the remaining
rewrite, including inline processPod preparation and the roadmap's helper inventory.
Current manager source has 12,995 lines after the milestone 22 extraction. The source
baseline below is authoritative; no milestone 23 product/test change has started.
The full goal remains completion through all Slice 34 architectural/qualification gates.

## Roadmap helper inventory

Paths/line numbers below refer to packages/daemon/src/pods/pod-manager.ts at 3fe37cd83168ee6a23377877f6b119d1eefbd2c0.
Nineteen function declarations and eight constant bindings are assigned to milestone 23.
The processPod declaration itself is assigned 24, with its provisioning portion assigned 23.

| Function | Current lines |
|---|---|
| resolveSpecFilePath | 361–372 |
| dataDir | 377–379 |
| safeFsSegment | 381–383 |
| materializeSpecContextFiles | 385–407 |
| ensureSeriesArtifactsDir | 409–419 |
| materializeSpecFiles | 421–459 |
| normalizeCommitEmail | 480–485 |
| buildAgentEnvFile | 557–566 |
| repairSandboxAgentHomeOwnership | 574–610 |
| captureDeployBaselineHashes | 827–885 |
| resolvePodSpawnImage | 972–998 |
| isAcrQualifiedImage | 1000–1003 |
| verifySandboxWarmImageAccess | 1005–1031 |
| assertSandboxAgentStreamingExecSupported | 2003–2021 |
| syncSandboxRuntimeSessionState | 2032–2085 |
| syncSandboxSeriesHandover | 2087–2116 |
| installGhBinary | 4165–4191 |
| installAzViaPip | 4196–4221 |
| buildCodeIntelligenceServers | 12940–12995 |

| Binding | Current lines | Existing public export |
|---|---|---|
| SPEC_CONTEXT_CONTAINER_DIR | 374–374 | No |
| POD_ARTIFACTS_CONTAINER_DIR | 375–375 | No |
| AGENT_SHIM_PATH | 511–511 | Yes |
| AGENT_ENV_PATH | 512–512 | Yes |
| AGENT_SHIM_SCRIPT | 525–555 | Yes |
| SANDBOX_AGENT_HOME_DIRS | 568–570 | No |
| SANDBOX_AGENT_HOME_FILES | 572–572 | No |
| MCP_INIT_PROBE_SCRIPT | 790–815 | No |

## Existing process flow and stage boundaries

processPod spans :5575–8435. Its outer state/guard/try setup occupies :5575–5621;
its try contains 140 consecutive top-level preparation statements before the
skipAgent dispatch branch at :7772. Existing contiguous source sections are:

| Lines | Existing work |
|---|---|
| 5622–6142 | Launch capability/cooldown checks, effective provider binding, interactive handoff/worker activation, worktree/spec/base materialization, startup retry/PIM admission, provisioning transition, credential projection, network snapshot and security scan |
| 6145–6523 | Backend/network allocation, registry material, sidecar specs/health/firewall, immutable and authenticated reference staging, image/capability checks, runtime state/spec/artifact mounts, main container spawn and deny-log receiver |
| 6530–6952 | Native workspace copy and Git reconstruction/restore/clean, tooling and handoff exclusions, Git author identity, reference installation, running transition and queued fix feedback |
| 6955–7021 | Skill resolution/writes, registry files and credential-guard hook shared by automatic and interactive pods |
| 7024–7287 | Interactive-only Claude UX setup, starting HEAD, history/memory export, PIM groups, project MCP merge, tool discovery docs and terminal hint; finishes startup and returns |
| 7290–7764 | Automatic MCP binary/init probes, broken launcher repair, proxy/actions/section resolution, provider credential files and ownership/shim modes, memory ranking, system instructions, runtime MCP token/config, registry checks and repository prepare command |

These rows describe current source ordering, not a proposed decomposition. The main
container is spawned before workspace materialization. The running transition occurs
at :6918, before shared skills/registry/hook material and before the interactive return.
The fix feedback queue drains only after that transition is committed. Interactive
pods finish startup and return without entering automatic provider credential setup.

From :7772 the same try handles skipAgent validation/completion, recovered terminal
completion, execution preflight, runtime/native Goal spawn/resume/fallback, event
consumption and post-run credential/completion decisions. Those algorithms remain
inside the current manager. This is the existing boundary around provisioning work,
not an assertion that processPod is already a thin composition function.

## Worktree, handoff and image behavior

- Initial queued/handoff status and lifecycle checks reject stale startup. A host
  fetch cooldown uses waitForRetryBackoff and rechecks the current binding/status.
- A live interactive handoff synchronizes source, commits/verifies its delta and
  persists rotated runtime credentials before stopping the container. Immutable
  launches additionally verify termination, kill sidecars/network and recheck
  ownership. Failure retains the interactive recovery mode/source and returns.
- Frozen worker activation can replace launch projection and selected runtime/model/
  account/target within its apply callback. Existing provider segments are closed/
  opened as part of that delegated operation. Local profile/reasoning variables are
  then refreshed from the current binding.
- Recovery worktrees require both a surviving gitlink and its bare metadata; missing
  metadata clears the recovery path and falls through to authenticated fresh create.
  Fresh create materializes spec files and persists the start SHA before container
  work, captures deployment baseline hashes and checks equivalent-work admission.
- Sandbox startup retries record admission/cooldown/start timestamps before PIM and
  provisioning; original recovery/error/finally logic settles that admission later.
- Immutable launches prepare their saved image; legacy sandbox images require an
  ACR-qualified warm tag and optional existence verification. Interactive mode is
  exempt from the streaming-agent backend guard.

## Files, environment and tools

resolveSpecFilePath rejects paths escaping the selected worktree. Spec context files
use DATA_DIR/default .autopod-data, sanitized pod ids and a reset per-pod context dir.
Spec files skip unchanged bytes and commit only changed paths; the returned HEAD
becomes the pod's start SHA. Shared series artifacts use sanitized series ids and a
handovers directory. normalizeCommitEmail retains explicit email or adds the local
Autopod suffix for legacy/pre-auth usernames.

AGENT_ENV_PATH/AGENT_SHIM_PATH/AGENT_SHIM_SCRIPT are existing public exports consumed
by e2e.test.ts, agent-shim.test.ts and pod-manager.test.ts. No product import of those
exports was found outside the manager; registry-injector.ts independently has the
same shim path constant. buildAgentEnvFile validates shell variable names and quotes
values. The shim sources the environment file, records its PID and expands selected
*_FILE credentials before exec.

repairSandboxAgentHomeOwnership uses a root exec only for sandboxes; an existing
SandboxInfrastructureError retains its identity and receives contextual message text.
Other failures/nonzero exit become errors. Existing sandbox/local secret and shim
file modes remain distinct in processPod; no credential policy is changed here.

The MCP_INIT_PROBE_SCRIPT is an existing bounded Python JSON-RPC initialize probe.
processPod binary-checks all code-intel servers, then probes survivors concurrently;
timeout/error diagnostics do not remove a discovered binary from the working list.
buildCodeIntelligenceServers derives Serena and Roslyn stdio definitions from the
profile flags and is also captured by runtime-resume context before provisioning.

installGhBinary/installAzViaPip are original logger-capturing helper declarations;
their actual callers are the installTools public control (:12357–12359), rather than
the current processPod preparation block. Their fixed scripts run in injected
container infrastructure; this research executes no download/install/cloud action.

## Shared state, errors and initialization

The preparation block mutates the outer pod and launchConfig references and the
stagedReferenceArchivePaths set; it records startupAdmission via the outer callback
state. Initial lifecycleGeneration, startingAttempt and setup-visible failure phase
also belong to the surrounding process run. finishStartup settles admissions and
clears its slot, so interactive early return plus the outer finally does not settle
twice. emitStatus and assertStartupCurrent close over original run identity.

Thirteen declarations created during preparation are later consumed by the dispatch
portion: containerManager, containerId, profile, isFreshContainerValidationOnly,
isRecovery, isInfrastructureRecovery, isRework, systemInstructions, secretEnv,
worktreePath, mcpServers, reasoningEffort and providerResult. The prepared pod and
launchConfig identities are also current outer values. Existing early returns and
throws can occur before a complete prepared set exists.

The original outer catch (:8232+)
settles startup admission according to observed runtime evidence, discards superseded
lifecycles, schedules safe sandbox/host-fetch recovery, reports missing refs/credentials,
persists credentials and parks failed provider continuation while retaining its history.
Its final fallback transitions failure only where current lifecycle permits. The outer
finally clears any unresolved startup admission and removes staged reference archives.
These handlers cover both preparation and runtime errors; they are not owned by a
new stage at this baseline.

syncSandboxRuntimeSessionState has a local AbortController/timeout and ownership
callback. It extracts Claude/Codex session state for sandboxes, catches/logs failures,
then aborts and clears the timeout. syncSandboxSeriesHandover reads a sandbox handover
file and writes the sanitized host series path; missing container material is logged.
The latter is captured by completion-source composition, while runtime session sync
is called from active event/run handling. Both are currently hoisted declarations.

Captured infrastructure references come from createPodManager's initial destructuring.
The inline preparation still reads original deps for optional launch services, provider
attempts, retry settings, credentials/actions/memory/token issuance and history data.
Static helper availability and constructor capture ordering matter independently from
runtime invocation: buildCodeIntelligenceServers is captured by runtime resume near
:2023 and syncSandboxSeriesHandover by completion source near :4030.

## Existing evidence and related modules

The unchanged manager suite has 1,192 cases. Relevant groups include startup retry and
handoff (:1255–1930), provider continuation protection (:5552–6531), shim/credential
file modes (:12434+), spec materialization and code-intelligence tool/probe cases,
interactive workspace behavior (:19531–19779), sandbox workspace/preview (:22113+)
and runtime preflight/recovery (:24698+). agent-shim.test.ts exercises the actual
rendered shell shim locally. Existing source collaborators include recovery-context,
reference-snapshots, provider-preflight, execution-preflight, worker-runtime-credentials,
workspace-transfer/preservation, registry-injector, skill/section resolvers and the
container/network/sidecar interfaces. Tests use controlled execution boundaries;
no live provider/Docker/Azure acceptance is established by source inspection.

Related research: 2026-10-18-pod-manager-continuation-goal-rework.md.
Canonical scope/inventory: 2026-10-18-pod-manager-remaining-roadmap.md.

## Qualified predecessor evidence

Slice 22 is complete at this unchanged source: all eighteen moved function bodies
and parameter lists, the constant and full extraction recipes match; 1,192 public
manager tests retain identical assertions/names/statuses. Fifty direct cases include
three private SQLite reopen cases. All 107 affected suites pass 3,551 tests. Full
uncached qualification passes 8,671 Vitest cases plus 35 script checks, with ten
inherited gated skips; 2,004 package/script hashes and six root controls match.
The initial task-launcher permission fault and successful unchanged-source rerun are
recorded in the Slice 22 plan/evidence. These are baseline results, not Slice 23
implementation evidence. No Slice 23 delivery gate is marked complete.

## Open questions and next phase

None for the current-state description. Next is the concrete milestone 23 plan from
these verified statements/helper references, preserving early returns, state shared
with error/finally handling, stage ordering, public shim exports and initialization.
This research changes no product/test bytes or behavior and does not mark any
milestone 23 delivery gate complete.

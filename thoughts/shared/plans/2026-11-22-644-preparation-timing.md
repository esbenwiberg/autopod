# #644 Repository preparation timing, cold-cache cause and continuation reuse — Implementation Plan

## Overview

Repository preparation (`npm ci && npm run bootstrap && <probe>`) took ~12–14 min in some runs and
18 s in another with identical inputs, and a provider continuation paid it again in full. This plan
(1) records per-stage durations, cache signals and probe timings in pod logs and
`execution-provenance`; (2) documents the code-provable cold-path cause and keeps today's behaviour
as the default where no safe warm path exists; (3) lets a provider continuation (and any recovery
that follows one) on the same worktree reuse the previous container's prepared dependencies when
every reuse input is unchanged, failing closed otherwise with a logged reason.

## Current State Analysis

See `thoughts/shared/research/2026-11-22-644-preparation-timing.md`. Key points:

- Preparation is one opaque exec (`packages/daemon/src/pods/repository-preparation.ts:236-249`);
  evidence has no timing or cache data (`packages/shared/src/types/execution-provenance.ts:5-14`).
- Every launch-config container starts without repository dependencies or package caches:
  software-only environment image (`images/environment-dockerfile.ts`), no cache volume
  (`pods/provisioning-container.ts:458-494`), `node_modules` excluded from populate and sync-back
  (`pods/workspace-mirror.ts:3-4`).
- Continuation syncs the workspace back (without `node_modules`), then kills **and removes** the
  container (`pods/provider-continuation.ts:213-245,490-520`;
  `containers/docker-container-manager.ts:687-720`); the next container prepares from scratch
  (`pods/provisioning-agent-materials.ts:572-614`).

## Cause (what the code supports, and what it does not)

- **Proven by code:** every preparation is a cold, full network install, and every continuation or
  recovery repeats it, because nothing preserves dependencies or caches across containers.
- **Not provable without live measurement:** why the same cold install took 18 s in run 3 but
  12–14 min in runs 1–2. Run 3 also started from an empty container, so a container-local cache
  cannot explain the difference. The remaining candidates are outside the container (registry/feed
  upstream warmness, egress proxy or restricted-network path, host contention) or in a later stage
  (bootstrap/probe). The instrumentation in Phase 1 separates these cases: install versus bootstrap
  versus probe stage time, cache presence, and preflight/probe overhead. This plan states that
  limit explicitly and ships only fixes the code supports.
- **Warm path default:** the only code-safe warm path is the same-pod continuation reuse in Phase 2.
  A cross-pod or cross-repository package cache crosses a trust boundary, because one pod could
  poison another pod's tool or browser downloads. It is a non-goal, recorded as a follow-up.

## Desired End State

- Each preparation records, in its evidence (and therefore in `GET /pods/:id/execution-provenance` and
  `ap execution-provenance`), the following data:
  `timing.totalMs`, `timing.commandMs`, `timing.preflightMs`, `timing.sourceProbeMs`, and
  `timing.stages[]` (`index`, redacted `label`, `durationMs`, `status` ∈ passed/failed/not-run/unknown)
  for each top-level `&&` stage, plus `cache.signals[]` (npm/pnpm/yarn/Playwright/pip/NuGet caches
  and workspace `node_modules`: present/absent/unknown) observed before the command runs.
- Pod activity shows one summary line, for example
  `Repository preparation passed in 742s — [1] npm ci 701s · [2] npm run bootstrap 37s · [3] node 4s; caches before: npm absent, node_modules absent`,
  and a failing stage is marked as failed. A structured `logger.info` line carries the same data.
- A provider continuation with unchanged inputs logs
  `Reusing prepared dependencies from the previous container (…restored N archives, X MiB in Ys)`,
  skips the prepare command, and records `reuse.decision='reused'`. Any changed input, a missing or
  corrupt snapshot, or a previous preparation that failed, was partial or wrote outside the
  workspace produces `Full repository preparation: reuse refused — <reason>` followed by the
  normal preparation.

### Key Discoveries

- Provenance is stored as a JSON payload (64 KiB bound), so optional evidence fields need no DB
  migration (`pods/execution-provenance-ledger.ts:62-80`).
- `assertPreparationSourceCurrent` requires only `status==='passed'`, the same `containerId` and the
  same source (`repository-preparation.ts:111-138`). Reused evidence produced in the new container
  satisfies it unchanged.
- The worker is non-root, so preparation can write only under `/workspace`, `$HOME`, `/tmp` and
  world-writable paths. All `/workspace` outputs except `node_modules`, `.serena`,
  `.roslyn-codelens` and `.git` already round-trip through the host worktree.
- Existing per-pod host state pattern: `runtimes/claude-state-store.ts` (env override, `~/.autopod`
  root, cleanup in `operator-kill.ts:151-161` and `workspace-deletion.ts:86-90`).

## What We're NOT Doing

- No shared cross-pod or cross-repository package or tool cache, and no new cache volume (trust
  boundary; follow-up issue).
- No reuse for validation preparation (`validation-provenance.ts`). Validation always prepares fresh.
- No reuse on the sandbox execution target (no archive import/export), and no snapshot when the old
  container is already gone (crash recovery after the container was lost). Both log a refusal
  reason and prepare in full.
- No reuse when preparation wrote outside `/workspace` (for example, Playwright browsers in
  `~/.cache`) or changed `/workspace/.git`. Those writes are not captured, so reuse is refused.
- No DB migration, no profile or launch-config field, no desktop change.
- No change to the prepare command's semantics, timeout or redaction rules.

## Implementation Approach

Instrument inside the existing single exec without changing `&&`/`set -e` semantics: a marker
function that always returns 0 is chained between stages, and an `EXIT` trap writes the end marker.
Markers carry only the stage index and a `/proc/uptime` reading and go to a random `/tmp` file that
is read back and deleted. Stage labels are derived from leading safe words and redacted with the
same hidden-value set as failure detail.

Continuation reuse is **lazy**, so the normal path pays nothing. Only when the daemon itself tears
down a container for a provider continuation, after the runtime is aborted and the workspace has
synced back, does it export each `/workspace/**/node_modules` directory as tar archives into a
daemon-owned per-pod host directory (not mounted into any container) with a manifest of reuse
inputs. The next provisioning of that pod consumes the snapshot once. It restores the archives only
if every key matches and the hashes verify. Otherwise it removes the snapshot and prepares normally.

Reuse key (all must match, fail closed):

| Input | Source at snapshot | Check in new container |
|---|---|---|
| previous preparation | latest provenance `repositoryPreparation.status==='passed'` for the torn-down container ID | manifest field |
| prepare command | `commandHash` | recomputed |
| workdir/timeout/env | `configurationHash` | recomputed |
| dependency inputs | new `dependencyInputs` fingerprint (lockfiles/manifests + files named in the command) | new probe |
| image | provenance `imageDigest` | preflight `imageDigest` (non-null) |
| target | `local` with archive support | same |
| outside-workspace writes | `outsideWorkspaceWrites==='none'` | manifest field |
| snapshot integrity | per-archive sha256 and size | verified before import |

Trade-off (accepted by the brief's reuse criterion): the dependency fingerprint covers dependency
manifests and lockfiles plus any repository file named in the prepare command, not the whole
source tree. The agent almost always edits source before a continuation, so a whole-tree key would
never match. A change to a script the bootstrap reaches only indirectly is not detected. Reused
`node_modules` also carries any in-place edits the previous agent made there, as the old container
would have.

## Phase 1: Per-stage timing, cache signals and surfacing

### Changes Required

#### 1. Evidence type
**File:** `packages/shared/src/types/execution-provenance.ts`
Add optional fields to `RepositoryPreparationEvidence`:
`timing?: { totalMs; commandMs: number|null; preflightMs?: number|null; sourceProbeMs: number|null; stageTiming: 'measured'|'unavailable'; stages: Array<{index; label; durationMs: number|null; status: 'passed'|'failed'|'not-run'|'unknown'}> }`,
`cache?: { signals: Array<{ name: string; state: 'present'|'absent'|'unknown' }> }`,
`dependencyInputs?: string|null`, `outsideWorkspaceWrites?: 'none'|'detected'|'unverified'`,
`reuse?: { decision: 'reused'|'refused'|'not-applicable'; reason: string; sourceContainerId?: string; restoredArchives?: number; restoredBytes?: number; restoreMs?: number }`.

#### 2. Stage instrumentation
**File:** `packages/daemon/src/pods/repository-preparation.ts`
- `splitPrepareStages(command): string[]` splits on top-level `&&` outside quotes, escapes,
  backticks and `$( ) ( ) { }` nesting. A command containing a newline or `<<`, or one with
  unbalanced quoting, becomes a single stage.
- `prepareStageLabel(segment, hidden)` takes up to 3 leading words matching
  `^[A-Za-z][A-Za-z0-9_.:@/+-]{0,31}$`. It stops at a word containing `=` and excludes hidden
  values. The fallback is `stage <n>`.
- `instrumentPrepareCommand(stages, timingPath)` builds `set -e`, the marker function, `trap 'mark end' EXIT`,
  and `mark 1 && s1 && mark 2 && s2 …`.
- `parseStageTiming(text, stageCount, exitCode)` maps markers to per-stage durations and statuses.
- `prepareLaunchRepository` measures the total, command and source-probe wall times, runs a
  best-effort cache-signal exec (5 s) before the command, and reads and deletes the timing file
  afterwards (best effort). It attaches `timing` and `cache` to the evidence on pass and on every
  failure path. It accepts `options.preflightMs`.
- Export `formatPreparationSummary(evidence)` to produce the one-line activity text.

#### 3. Surfacing
**Files:** `pods/provisioning-agent-materials.ts`, `pods/validation-provenance.ts`, `packages/cli/src/commands/pod.ts`
- Agent materials measure `inspectExecutionPreflight` and pass `preflightMs`. The `record` callback
  emits `formatPreparationSummary` once the status is terminal and logs the structured
  `{podId, timing, cache, reuse}`.
- Validation preparation logs the same structured line through its existing logger or activity
  dependency (no activity line if the dependency does not exist there).
- `ap execution-provenance` prints the preparation status, the timing stages, the cache signals and
  the reuse decision when they are present.

### Success Criteria

#### Automated Verification
- [ ] `repository-preparation.test.ts`: the splitter handles quotes, subshells, `$(…&&…)`,
      heredoc/newline fallback, and labels redact secrets and env values.
- [ ] A passing 3-stage run records 3 stage durations from marker output, plus the cache signals.
- [ ] A failing second stage records stage 1 passed, stage 2 failed with a duration, and stage 3
      not-run, and the evidence is recorded with timing.
- [ ] Missing or garbled markers give `stageTiming:'unavailable'` while preparation still passes.
- [ ] Agent-materials or provenance test: the summary is emitted and the provenance contains timing.
- [ ] CLI test: `ap execution-provenance` prints the stages.
- [ ] `npx pnpm --filter @autopod/daemon exec vitest run <touched tests>`, plus shared, daemon
      and CLI typecheck.

#### Manual Verification
- [ ] On a live local-Docker pod, the activity shows a per-stage summary and the `ap execution-provenance` output matches.

---

## Phase 2: Fail-closed continuation reuse

### Changes Required

#### 1. Reuse-input probes
**File:** `pods/repository-preparation.ts`
- `PREPARATION_DEPENDENCY_PROBE` (node, read-only, same git hardening as the source probe) hashes
  the tracked and nonignored-untracked files whose basename is in `DEPENDENCY_MANIFEST_NAMES`
  (package.json, package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, pnpm-workspace.yaml,
  yarn.lock, .yarnrc, .yarnrc.yml, .pnpmfile.cjs, bun.lock, bun.lockb, .nvmrc, .node-version,
  .tool-versions), plus repository files named by path-like words in the prepare command, passed
  as argv. Excludes `node_modules`. It runs before the command and sets `evidence.dependencyInputs`
  (null when unverified).
- Outside-workspace write check: touch a random `/tmp` marker before the command. After a passing
  command, `find "$HOME" /workspace/.git -xdev` prunes re-downloadable package-manager caches and
  agent runtime state, then lists files and symlinks with `-cnewer marker` (bounded) and records
  `outsideWorkspaceWrites`. This field is informational for the result and decisive for reuse.

#### 2. Snapshot store
**New file:** `pods/prepared-dependency-snapshot.ts`
- `preparedDependenciesDirForPod(podId)` (`AUTOPOD_PREPARED_DEPENDENCIES_DIR` override, default
  `~/.autopod/prepared-dependencies/<podId>`), `cleanupPreparedDependencies(podId)`.
- `capturePreparedDependencySnapshot({pod, containerId, cm, provenance, logger})` returns
  captured or skipped with a reason. It requires the local target, `cm.exportPathArchive`, a passed
  evidence for this container, `outsideWorkspaceWrites==='none'`, and non-null `dependencyInputs`
  and `imageDigest`. It lists `node_modules` directories (bounded at 500) and exports each to
  `archives/NNN.tar` while hashing. Capture is bounded by bytes (`AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES`,
  default 4 GiB) and by time (5 min). The manifest is written last with an atomic rename. Any
  failure removes the directory.
- `decidePreparationReuse(manifest|null, current)` is pure and returns
  `{reuse:true}|{reuse:false, reason}`. The reasons are no-snapshot, unsupported-target,
  previous-preparation-not-passed, outside-workspace-writes, command-changed,
  configuration-changed, dependency-inputs-changed, image-changed and image-unverified.
- `restorePreparedDependencySnapshot(...)` verifies the size and sha256 of every archive, then
  calls `cm.importPathArchive` into each parent directory. If any step fails, it runs `rm -rf` on
  the restored paths and reports `restore-failed`.

#### 3. Container manager seam
**Files:** `interfaces/container-manager.ts`, `containers/docker-container-manager.ts`, `test-utils/mock-helpers.ts`
Add optional `exportPathArchive(containerId, containerPath, hostFile, {maxBytes}) → {bytes, sha256}`
(streams `getArchive` to a file and aborts above the limit) and
`importPathArchive(containerId, hostFile, containerDir)` (streams the file to `putArchive`). Both
respect `assertNotRetained`. Sandbox omits both.

#### 4. Capture at continuation teardown
**File:** `pods/provider-continuation.ts`
In `handleProviderLimit` and in the operator-selected continuation, after `syncWorkspaceBack` and
before `cm.kill`, call capture (best effort, never fails the continuation) and log
`Prepared dependencies saved for continuation (N archives, X MiB)` or the skip reason. The
`captured` dependency is injected via the continuation ports.

#### 5. Restore at provisioning
**Files:** `pods/provisioning-agent-materials.ts`, `pods/repository-preparation.ts`
- `prepareLaunchRepository` accepts
  `options.reuse?: { attempt(current) → Promise<{reused, reason, stats}> }`. After the source and
  dependency probes it calls `attempt`. When reused, it re-runs the source probe (which must be
  equal), sets `status='passed'`, `exitCode=null`, the `reuse` stats, and
  `outsideWorkspaceWrites` carried from the manifest, then records and returns without running
  the command. When reuse is refused, it records `reuse.decision='refused'` with the reason and
  runs the normal path.
- Agent materials enable reuse only for `isRecovery && !isFreshContainerValidationOnly` with a
  prepare command, and pass the preflight `imageDigest`. A non-recovery provisioning deletes any
  stale snapshot (`not-applicable`). The snapshot directory is consumed (deleted) after every
  attempt.
- Activity: `Reusing prepared dependencies…` or `Full repository preparation: reuse refused — <reason>`.

#### 6. Cleanup
**Files:** `pods/operator-kill.ts`, `pods/workspace-deletion.ts`
Call `cleanupPreparedDependencies` next to the runtime-state cleanup (best effort).

### Success Criteria

#### Automated Verification
- [ ] `prepared-dependency-snapshot.test.ts`: `decidePreparationReuse` returns reuse for unchanged
      inputs. Each changed input (lockfile/dependency fingerprint, command hash, configuration
      hash, image digest), a non-passed previous preparation, outside-workspace writes and a
      missing snapshot each refuse it with the expected reason.
- [ ] Capture/restore round trip with a fake container manager and a temporary directory:
      manifest last, hash mismatch refused and cleaned, byte limit aborts, sandbox/no-seam skips.
- [ ] `repository-preparation.test.ts`: with reuse accepted, the prepare command is never executed,
      the evidence is passed with `reuse.decision==='reused'`, and the source check passes.
      Refused reuse runs the command and records the reason.
- [ ] Provider-continuation test: capture is called between sync and kill, and a capture failure
      does not block the continuation.
- [ ] Docker manager unit tests for `exportPathArchive` and `importPathArchive` (mocked dockerode
      streams, byte limit).
- [ ] Daemon, CLI and shared typecheck; Biome lint on changed files; affected test files pass.

#### Manual Verification
- [ ] Live local-Docker pod: force a provider continuation. The second provisioning logs reuse and
      starts the worker without running `npm ci`, and the agent's `npm test` works.
- [ ] Change `package-lock.json` before the continuation and confirm the reuse refusal reason and
      the full preparation.

---

## Testing Strategy

Unit tests use fake `ContainerManager` objects (as in the existing `repository-preparation.test.ts`)
and temporary host directories (env override). No Docker is needed. The provider-continuation tests
extend the existing continuation test file's fixtures.

### Manual Testing Steps
1. Run a local-Docker pod with a `npm ci && npm run bootstrap` prepare command. Check the per-stage
   summary activity line and `ap execution-provenance <pod>`.
2. Trigger a provider continuation. Check the "saved" line, then "Reusing prepared dependencies"
   and the worker start a few seconds later.
3. Repeat with a lockfile edit and confirm the refusal and full preparation.

## Performance Considerations

- Normal path: adds a cache-signal exec (≤5 s, typically <100 ms), a dependency probe (<1 s), a
  marker file read and a bounded `find` over `$HOME` and `.git` after the command (≤5 s).
- Continuation: capture and restore cost is proportional to `node_modules` size (tar over the
  Docker API, roughly tens of seconds per GiB). It is bounded at 4 GiB and 5 min, and replaces a
  full install that can take many minutes.
- Host disk: at most one snapshot per pod, which exists only between teardown and the next
  provisioning, plus cleanup on kill and delete.

## Migration Notes

No DB migration. All evidence fields are optional, and historical records stay valid. Rollback:
reverting removes reuse. Leftover snapshot directories are inert and can be deleted from
`~/.autopod/prepared-dependencies`.

## References

- Original task: issue #644 (brief in pod spicy-cockroach)
- Research: `thoughts/shared/research/2026-11-22-644-preparation-timing.md`
- Similar pattern: `packages/daemon/src/runtimes/claude-state-store.ts`, `pods/provider-continuation.ts:118-131` (#646 budget gate)

## Approval and conditions (2026-11-22, owner via orchestrator)

Approved as option A, with the following binding conditions:

1. **Stage splitting never changes what runs.** If there is any doubt (newline, heredoc `<<`,
   comment `#`, `$(`, backticks, `(`/`)`/`{`/`}` subshells or groups, `||`, pipes, `;`, a lone
   `&`, `!`, a backslash or line continuation, `&&` inside quotes, unbalanced quotes, or an empty
   segment), the command is a single stage. A single stage gets its marker as a separate no-op line
   before the unchanged command, not chained. The marker function always returns 0, writes only to
   its own `/tmp` file, and redirects its own stderr. The EXIT trap does not change the exit status.
   Tests execute the generated script with real `/bin/sh` and compare the exit code and
   stdout/stderr against the uninstrumented command, including tricky inputs. A failure-detail test
   confirms the output is unchanged.
2. **Snapshot disk bounds:** consumed once, then deleted. Snapshots are deleted when the pod is
   missing or no longer queued/provisioning, by a sweep at startup and on an interval (a 15-minute
   grace for an in-progress capture, and a 24-hour hard age), as well as on kill and delete. There
   is a global cap of 8 GiB across pods (`AUTOPOD_PREPARED_DEPENDENCIES_TOTAL_MAX_BYTES`) in
   addition to 4 GiB per pod. Capture is skipped when free host disk is below
   `max(2 GiB, 2 × per-pod cap)`. Every skipped capture and refused reuse is logged with its
   reason. The directory is created with mode 0700 and is never mounted into containers.
3. **Capture is best effort and bounded** (5 min). On timeout or error the snapshot is removed and
   the continuation proceeds; the next provisioning prepares in full.
4. **Validation and fresh launches always prepare from scratch.** A test proves that validation
   preparation never consumes a snapshot.
5. **Phase 1 is committed separately**, before Phase 2.

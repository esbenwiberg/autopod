---
date: 2026-11-22T20:05:34+00:00
researcher: Claude (Autopod pod spicy-cockroach)
git_commit: 76f3bac25667306c672e116c9c07adaa4ef11711
branch: fix/644-preparation-timing
repository: autopod
topic: "#644 — where repository preparation time goes, why it can be cold, and how continuation/recovery re-prepare"
tags: [research, codebase, repository-preparation, provider-continuation, execution-provenance]
status: complete
last_updated: 2026-11-22
last_updated_by: Claude
---

# Research: repository preparation timing, cache state and continuation re-preparation (#644)

## Research Question

For a launch whose repository setup has `prepareCommand` (`npm ci && npm run bootstrap && <probe>`),
document: (1) the call chain from the "Preparing repository dependencies…" status to the configured
command; (2) what timing/cache evidence is recorded today; (3) which package/tool caches a fresh
container starts with; (4) what happens to prepared dependencies on a provider continuation and on
recovery ("Recovering pod — reusing existing worktree").

## Summary

- Preparation is a **single opaque exec** of `set -e\n<prepareCommand>` inside the pod container
  (`packages/daemon/src/pods/repository-preparation.ts:236-249`). Nothing records start/end times,
  per-stage durations or cache state. Evidence (`RepositoryPreparationEvidence`) carries only status,
  hashes, source fingerprint, exit code and a redacted failure detail
  (`packages/shared/src/types/execution-provenance.ts:5-14`).
- "Prepare start → worker start" also includes two `inspectExecutionPreflight` passes (one before
  preparation, one before "Starting worker") plus two source probes; these are bounded to seconds
  (CLI probe timeout + 3 attempts; source probe 15 s), so a 12-minute gap can only plausibly come
  from the prepare command itself (whose timeout is the launch `buildTimeout`, default 300 s).
- For launch-config pods every container starts **without any repository dependency cache**:
  the image is the software-only environment image (`images/environment-dockerfile.ts:3-20` — "no
  checkout, repository scripts"), no package-cache volume is mounted
  (`pods/provisioning-container.ts:458-494`), `node_modules` is excluded when `/workspace` is
  populated from the worktree (`pods/workspace-mirror.ts:3`, `pods/provisioning-workspace-population.ts:74-86`)
  and when it is synced back (`WORKSPACE_SYNC_EXCLUDES`, `pods/workspace-transfer.ts:440`).
  `repositoryCacheKey()` exists (`images/repository-cache-key.ts`) but nothing calls it outside tests.
- Therefore *every* preparation (first run, continuation, recovery, rerun) is a full install that
  downloads every package through the pod's egress path. Run 3 of the issue (fresh container, 18 s)
  shows that an empty container-local cache alone does not produce a 12-minute install; the
  variable is outside the container (registry/feed upstream warmness, egress proxy, host
  contention) or inside a later stage (bootstrap/probe). The code cannot distinguish these; there
  is no recorded evidence to do so.
- A provider continuation (`pods/provider-continuation.ts:197-260` automatic,
  `:490-520` operator-selected) aborts the runtime, syncs `/workspace` back to the host worktree
  (excluding `node_modules`), and **kills + removes** the container
  (`containers/docker-container-manager.ts:687-720`). It re-queues with
  `recoveryWorktreePath = worktreePath`; provisioning emits "Recovering pod — reusing existing
  worktree…" (`pods/provisioning-workspace.ts:433-438`) and spawns a new container, which runs the
  full preparation again (`pods/provisioning-agent-materials.ts:572-614`). Only the worktree (without
  `node_modules`) survives. Crash recovery (`pods/local-reconciler.ts:453-468`), Goal resume and
  infrastructure resume (`pods/continuation-controls.ts:124,438`) take the same route.

## Detailed Findings

### Call chain

1. `createProvisioningAgentMaterials().prepareAgentMaterials` (`pods/provisioning-agent-materials.ts:81`)
   receives `isRecovery`, `isFreshContainerValidationOnly`, etc. from session materials.
2. If `launchConfig.repository.setup.prepareCommand` is set: `emitStatus('Preparing repository
   dependencies…')` (`:573`), then `inspectExecutionPreflight(... 'coding','worker')` (`:576-584`),
   which probes the agent CLI (`runtimes/agent-cli-preflight.ts`, up to 3 attempts), required
   commands (`pods/required-command-preflight.ts`, 15 s) and container metadata (image digest,
   memory, CPU, network mode — `pods/execution-preflight.ts:140-160`).
3. `prepareLaunchRepository(launchConfig, cm, containerId, env, {assertCurrent, sensitiveValues,
   record})` (`:587-614`, implementation `pods/repository-preparation.ts:176-271`):
   - builds evidence with `commandHash`, `configurationHash` (workdir, timeout, sorted env) (`:187-200`);
   - `inspectPreparationSource` runs `PREPARATION_SOURCE_PROBE` (hash of HEAD + every tracked and
     nonignored-untracked file) (`:38-109`);
   - runs `wrapValidationExecCommand('set -e\n' + command, env, literals)` with
     `timeout = (buildTimeout ?? 300) * 1000`, `maxOutputBytes: 65536`, `requireObservedExit` (`:236-249`);
   - on failure builds a redacted detail via `failureDetail()` (hides env values, secrets, the full
     command and every command word ≥ 8 chars, credential lines, URLs) (`:124-160`);
   - re-runs the source probe and fails if the source changed (`:263-268`); status `passed`.
   - `record(evidence)` writes the provenance via `podRepo.executionProvenance.record` (JSON payload
     in `execution_provenance`, 64 KiB bound — `pods/execution-provenance-ledger.ts:62-68`).
4. `agent-process-workflow.ts:247-300` runs another `inspectExecutionPreflight`, attaches
   `repositoryPreparation`, records provenance, and before spawn re-checks
   `assertPreparationSourceCurrent` (requires `status==='passed'`, same `containerId`, same source).
5. Validation (`pods/validation-provenance.ts:50-124`) independently re-runs
   `prepareLaunchRepository` in the validation container; it never consults earlier evidence.

### Evidence surfaces

- `GET /pods/:podId/execution-provenance` returns `latest` (`api/routes/pods.ts:871-886`).
- `ap execution-provenance <id>` prints CLI/provider/image/resources/commands/diagnostics but not
  `repositoryPreparation` (`packages/cli/src/commands/pod.ts:160-198`).
- Pod logs: `emitStatus` / `logger` only show "Preparing repository dependencies…" and failure text.
- Desktop and mobile-web do not decode `repositoryPreparation` (no references).

### Caches a fresh container has

- Launch-config image: `prepareEnvironment(launchConfig)` (`pods/provisioning-container.ts:346-349`)
  → environment image built from tool installs + `environment.prepareCommands` + CLI installs,
  run as `autopod` in `/home/autopod`; no checkout, so no repository dependency cache
  (`images/environment-dockerfile.ts`).
- Legacy profile warm images do pre-warm with an inferred install (`images/dockerfile-generator.ts:112-119`)
  but that path is not used when a launch config exists.
- Volumes mounted at spawn: recovery handoff, `/mnt/worktree`, bare repo, spec context, inputs,
  series artifacts, Claude/Codex state dirs (`pods/provisioning-container.ts:458-494`). No
  npm/pnpm/yarn/pip/Playwright cache mount; no `npm_config_cache` anywhere in daemon source.
- The worker runs as a non-root user, so preparation can only write under `/workspace`, `$HOME`,
  `/tmp` and world-writable paths.

### Continuation / recovery

- `handleProviderLimit` (`provider-continuation.ts:197-260`): abort runtime → `syncWorkspaceBack`
  → stop preview proxy / HAProxy receiver → `cm.kill` (stop + force remove) → select target →
  `queueProviderContinuation` (`:133-195`) → `assertContinuationBudgetAdmissible` (#646) → update pod
  (`containerId:null, recoveryWorktreePath: worktreePath`) → `queued`.
- Operator-selected continuation (`:440-560`) has the same sync → kill sequence.
- `syncWorkspaceBack` excludes `.git`, `node_modules`, `.serena`, `.roslyn-codelens`
  (`pods/workspace-mirror.ts:3-4`); all other ignored outputs (e.g. `dist/`) round-trip through
  the host worktree and are repopulated into the next container.
- Host per-pod state dirs follow the `claude-state-store.ts` pattern (env override, root under
  `~/.autopod`, cleanup on kill/deletion via `operator-kill.ts:151-161` and
  `workspace-deletion.ts:86-90`).
- Docker file transfer uses `getArchive`/`putArchive` (`docker-container-manager.ts:754-880`);
  `ContainerManager` exposes no generic path archive export/import.

## Code References

- `packages/daemon/src/pods/provisioning-agent-materials.ts:561-614` — preparation entry.
- `packages/daemon/src/pods/repository-preparation.ts:38-109,176-271` — source probe, prepare exec.
- `packages/shared/src/types/execution-provenance.ts:5-14,43` — evidence type.
- `packages/daemon/src/pods/agent-process-workflow.ts:247-300` — worker provenance + source recheck.
- `packages/daemon/src/pods/validation-provenance.ts:50-124` — validation re-preparation.
- `packages/daemon/src/pods/provider-continuation.ts:133-260,490-520` — continuation teardown/requeue.
- `packages/daemon/src/pods/provisioning-workspace.ts:332-438` — recovery detection and worktree reuse.
- `packages/daemon/src/pods/workspace-mirror.ts:3-4` — runtime cache excludes.
- `packages/daemon/src/images/environment-dockerfile.ts` — software-only image.
- `packages/daemon/src/images/repository-cache-key.ts` — unused repository cache key.
- `packages/daemon/src/containers/docker-container-manager.ts:687-720` — kill removes container.
- `packages/cli/src/commands/pod.ts:160-198` — `ap execution-provenance` printer.

## Architecture Documentation

Preparation evidence is per candidate container ("never a reusable runner-readiness certificate",
`execution-provenance.ts:4`) and is checked again before dispatch against the same container ID.
Provenance is a JSON payload; adding optional fields needs no migration. Command text is never
persisted; only hashes and redacted failure detail are.

## Open Questions

- Which stage consumed the 12–14 minutes in runs 1–2 cannot be determined from code; no timing was
  recorded. This requires the instrumentation planned for #644 and a live measurement.

---
date: 2026-10-17T19:13:11+02:00
researcher: Codex
git_commit: 6e51d1ce9495235e6aac2e498393cd2dd9a0e66b
branch: codex/pod-manager-workspace
repository: autopod
topic: "Workspace preservation, checkpoint delegation, transfer, and recovery in pod-manager"
tags: [research, codebase, pod-manager, workspace, recovery]
status: complete
last_updated: 2026-10-17
last_updated_by: Codex
---

# Research: pod-manager workspace preservation

## Research question

Following the user's acceptance of incremental pod-manager decomposition, establish
the existing workspace preservation boundary: its callers, dependencies, ownership,
durable records, transfer behavior, and observable test coverage.

## Source and method

The isolated worktree is /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Remote main was read through git ls-remote, explicitly fetched, and checked out at
6e51d1ce9495235e6aac2e498393cd2dd9a0e66b. The preceding local default reference was
6765a071. The intervening PR #438 does not change the manager, its tests, checkpoint
controller, bare-push helper, or sandbox checkpoint primitive.

The original checkout contains concurrent managed-runtime work and was preserved.
This research consists of source inspection, symbol/caller searches and Git checks.
No application tests, Docker commands, cloud operations, or model work were run.
The fresh worktree has no installed node_modules. Historical test results below
are attributed to the earlier campaign, never treated as fresh execution.

## Summary

Workspace preservation is currently composed inside createPodManager. Its
preservePodWorkspace helper selects Docker synchronization or sandbox checkpoint
capture. checkpointSandboxWorkspaceForPod prefers the injected checkpoint controller
and otherwise coalesces direct checkpoint calls in a manager-local map.

These helpers do not decide pod status or remove containers. Their callers retain
those responsibilities. Docker transport, validation reconciliation, Git publication,
and sandbox checkpoint records are separate existing mechanisms. Some callers still
invoke generic synchronization for sandbox targets; checkpoint-only behavior does
not describe every manager path.

## Detailed findings

### Preservation entry point

packages/daemon/src/pods/pod-manager.ts:5657 defines preservePodWorkspace.

- Missing containerId or worktreePath returns without selecting infrastructure.
- Sandbox preservation probes the captured container. Unknown status throws the
  existing unavailable error. Stopped status invokes start before capture.
- Sandbox success requires promoted, materialized and lineageVerified. The helper
  propagates checkpoint exceptions and throws the checkpoint message, or its
  existing fallback message, when those three fields are incomplete.
- Local preservation invokes syncWorkspaceBack with captured container, host path,
  pod ID and execution target. It logs the pushed result and emits the existing
  activity string. A false pushed value is not itself an exception here.
- The helper accepts a Pod snapshot. It contains no repository read/update,
  lifecycle-generation comparison, decision admission, cleanup or transition.
  This does not establish cancellation or fencing of already-issued transfer work.

The public preserveWorkspace operation at :14613 reads the current pod and calls
this helper. It does not itself complete or delete the pod.

### Sandbox checkpoint delegation and duplicate handling

packages/daemon/src/pods/pod-manager.ts:5697 defines
checkpointSandboxWorkspaceForPod. The sandboxCheckpointRuns map is created at :4005.

- An incomplete workspace produces the complete existing NO_WORKSPACE result,
  with sequence zero, empty identities, false proof fields and a nonretryable
  capture error.
- The direct in-flight map is keyed only by pod ID and scoped to the manager
  instance. It is not durable authority and does not distinguish lifecycle/cycle.
- An existing direct operation is returned before controller delegation.
- With a controller, request(pod.id, 'completion') runs first. A present result is
  returned unchanged, including failed/partial proof. A thrown controller error
  propagates. Only a fulfilled decision without result reaches the direct fallback.
- The fallback uses deps.sandboxWorkspaceCheckpoint or checkpointSandboxWorkspace,
  sandbox container infrastructure, the captured workspace identity, and Date.now()
  as sequence. Finally deletes the direct map entry on success or rejection.
- The map is populated after controller delegation. Its exact ordering is distinct
  from the controller's own coalescing and must not be described as universal
  generation-aware serialization.

### Checkpoint controller and persistent records

packages/daemon/src/pods/workspace-checkpoint-controller.ts is an existing class,
not a manager-local transport implementation.

- :115 request observes a fingerprint before entering run.
- :171 run coalesces in-flight work per pod.
- :209 execute uses a global semaphore, continues sequences from stored records,
  retries only typed retryable failures, saves the resulting proof and telemetry,
  and releases the semaphore in finally.
- :123 mayDestroy checks a freshness lease on the latest verified record.
- :132 reconcileIncomplete only delegates materialization for already-imported
  results whose lineage is verified and for which an adapter was supplied.

Production composition at packages/daemon/src/index.ts:733 wires real checkpoint
records, reads the current pod when observing/capturing, and uses the Git-native
checkpoint primitive. The same controller is passed into pod-manager at :847.
Startup invokes reconcileIncomplete at :1276. Production's controller callbacks
read current pod identity, while the manager's direct fallback captures its passed
Pod identity; these are distinct current semantics.

### Source transfer and Git authority

packages/daemon/src/pods/pod-manager.ts:5642 wraps syncWorkspaceBackOnce in
withEngineStallRetry (:5585). Engine errors are classified at :5525; reachability
polling at :5550 is also used by validation infrastructure recovery (:14947).

syncWorkspaceBackOnce (:6198) routes sandbox targets directly to archive extraction.
For Docker it derives the expected bare repository on the host, compares it with
container-supplied alternates, adds Git safe.directory configuration, attempts a
staging-ref push, and runs copy-first/delete-after file synchronization. A false
push result remains visible to caller deletion guards. Any caught exec/copy failure
attempts archive extraction before the outer engine retry classifies a rejection.

extractWorkspaceBackAndRecoverGit (:6363) preserves the host .git entry, extracts
files with cache exclusions, then attempts separate .git recovery through a temporary
directory. Commit recovery is best effort. A successful push refreshes the host
index; refresh errors propagate. Temporary Git cleanup is best effort in finally.

recoverWorktreeFromContainer (:6438) requires running status, checks the alternates
path before a commit push, extracts workspace files and refreshes the index. It
returns false on caught failure. Higher-level retry recovery at :6665 owns clearing
worktreeCompromised and preSubmitReview.

packages/daemon/src/worktrees/bare-push.ts already owns staging-ref publication,
fast-forward verification, compare-and-set branch promotion, and ref cleanup.
packages/daemon/src/worktrees/sandbox-workspace-checkpoint.ts already owns private
index capture, Git bundle verification/import, quarantined lineage, branch promotion,
materialization verification and guarded rollback. Its structured proof fields
must not be summarized as an undifferentiated boolean.

Shared mirror helpers/constants at manager :619-690 also feed provisioning (:9575)
and approval snapshot exclusions (:629). deriveBareRepoPath (:1104) also feeds
reconciliation (:5958) and provisioning (:8979); it is not private to synchronization.

### Callers and lifecycle ownership

| Existing caller | Source location | Responsibility retained by caller |
|---|---|---|
| Fatal-agent preservation | pod-manager.ts:5737; called at :11250 and :11357 | Catch preservation failure and retain sandbox; cleanup after fulfilled preservation. |
| Worker awaiting a human decision | :12134 | Preserve source, then record awaiting-human settlement. |
| Worker with queued, uncollected guidance | :12158 | Preserve source, verify existing completion ownership, then update journal/status. |
| Public preservation request | :14613 | Read current pod and delegate. |
| Forced Rework | :14772 | Preserve source before destructive rework operations. |
| Automatic sandbox completion | :12200 | Require checkpoint proof before subsequent source/validation decisions. |
| Validation paths | :14984 and :15198 | Interpret checkpoint proof and manage validation lifecycle. |
| Compromised-worktree recovery | :18869, checkpoint at :18897 | Resume sandbox if needed; clear compromised flag only after accepted proof. |

Other source synchronization consumers include provider-limit handling (:2987),
provisioning recovery (:8699), interactive completion (:14323), workspace branch
sync (:14529), and explicit provider continuation (:18526). These continue to call
generic syncWorkspaceBack. Routing them all through the preservation helper would
change current behavior.

cleanupContainer (:3587) separately handles captured container identity, ownership
of shared resources, memory extraction, timeouts, credentials and conditional
container-pointer clearing. Artifact finalization has its own cycle ownership
checks in packages/daemon/src/pods/artifact-finalizer.ts. Neither responsibility
belongs to the current two preservation helpers.

### Existing coverage observed in source

These are located assertions, not tests executed in this research:

- pod-manager.test.ts:1930 resumes a stopped sandbox for recovery.
- :1952 rejects checkpoint-unavailable recovery without recursive source extraction.
- :1996 retains the compromised flag on incomplete materialization.
- :2038 retains local Docker recovery.
- :14443 and :20752 exercise fallback recovery before validation/completion.
- :20797 checks exclusion content and generated mirror-script structure.
- :20831 exercises checkpoint-only automatic sandbox completion.
- :23514 kills a failed sandbox after successful preservation.
- :23542 retains the sandbox after checkpoint rejection.
- :23574 exercises the public failed-sandbox preservation operation.
- workspace-checkpoint-controller.test.ts covers dirty-fingerprint intervals,
  durability leases, global concurrency, persistent sequence continuation,
  typed retries, duplicate requests and corrupted result retention.
- sandbox-workspace-checkpoint.test.ts uses real local Git bundles and checks dirty
  snapshots, repeated checkpoint lineage and divergence barriers.
- bare-push.test.ts exercises real local Git staging-ref publication.

The public preservation cases inspected do not directly establish every branch of
controller delegation (result versus absent result versus rejection), release of
the manager's direct-fallback map after rejection, or missing-workspace no-op behavior.
No claim is made that this search exhausts all indirect coverage.

## Architecture documentation

The existing artifact-finalizer extraction uses a typed factory composed inside
createPodManager. Shared admission and lifecycle policy remain in the manager;
the extracted module receives narrowly typed collaborators. Its plan records
characterization before production movement and identical reruns afterward:
thoughts/shared/plans/2026-10-15-artifact-finalizer-extraction.md.

## Related research and historical context

- thoughts/shared/research/2026-10-15-artifact-finalization-boundary.md.
- thoughts/shared/plans/2026-10-15-reliability-campaign.md.
- thoughts/shared/plans/2026-10-16-reliability-final-report.md.
- The final report describes the artifact module as the campaign's first extraction.
  Its historical verification does not qualify a future workspace extraction.

## Open questions

None for the described current-state map. Already-issued transfer cancellation,
cross-generation checkpoint publication, and legacy sandbox routing were not
qualified as corrected or proven by this research.

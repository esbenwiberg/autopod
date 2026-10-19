---
date: 2026-10-17T20:55:19+02:00
researcher: Codex
git_commit: 1a2dd0c8a82db8e16f36c0849e91945e101e75e1
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 3: workspace preparation before validation"
tags: [research, codebase, pod-manager, validation-workspace]
status: complete
last_updated: 2026-10-17
last_updated_by: Codex
---

# Research: workspace preparation before validation

## Research question

Locate the next coherent workspace boundary after the completed preservation and
transfer extractions. Describe the validation preparation implementation, callers,
error classification and existing evidence.

## Summary

Eight private helpers still implement validation workspace inspection and Git
reconciliation inside pod-manager. They compare host and container HEAD/status,
choose existing synchronization or reset paths, and reconcile sandbox divergence
using existing graft and bundle primitives. Two public orchestration paths use
the preparation operation, with different sandbox routing and failure handling.
The isolated rewrite worktree is clean at 1a2dd0c8.

All source references below are relative to packages/daemon/src/ at that commit.

## Detailed findings

### Inspection and decision tree

- pods/pod-manager.ts:5500 and :5512 read host HEAD/status with host Git. Exceptions
  become null. HEAD is trimmed; porcelain status is returned unchanged.
- :5524 and :5548 read the same information in /workspace with 10-second exec
  timeouts. Nonzero exits and thrown failures become null.
- :5572 compares ancestry in the container: exit 0 is true, exit 1 is false,
  another exit is null. A transport rejection propagates rather than becoming null.
- :5598 resets the container with git reset --hard, then git clean -fd; both use
  30-second timeouts. Nonzero results throw ValidationWorkspaceReconcileError.
  Transport exceptions propagate in their original form.
- :5862 prepares with four parallel observations. Missing either HEAD invokes
  syncWorkspaceBack. Equal HEADs synchronize unless container status is definitely
  clean; host dirty/unknown status does not independently force sync in this branch.
- If container HEAD is an ancestor of host HEAD, preparation resets/cleans the
  container. If host HEAD is an ancestor of container HEAD, it synchronizes back.
  Dirty status is logged but does not veto these existing ancestry decisions.
- If neither ancestry probe returns true, sandbox targets attempt reconciliation;
  other targets throw ValidationWorkspaceReconcileError. Null ancestry observations
  therefore share the final guard with demonstrated non-ancestry.

### Sandbox divergence reconciliation

- :5650 collects host-side lineage/tree diagnostics, derives the bare path using
  worktrees/bare-push.ts:10, and names refs/autopod-reconcile/<podId>.
- It first checks whether container HEAD is already available on the host. Only
  when the object is missing does it validate container alternates against the
  host-derived path and attempt a push to the reconcile ref.
- Host-side ancestry determines whether host HEAD is already the target. Otherwise
  worktrees/graft-reconcile.ts:37 re-parents the host's indexed tree onto container
  HEAD using its existing reset/commit algorithm.
- An equal target returns success without bundle/reset. Other targets go through
  worktrees/sandbox-reconcile.ts:35, transferring a real bundle to the isolated
  container object store before the final reset and clean.
- The outer finally attempts reconcile-ref cleanup, host bundle removal and remote
  bundle removal. Host bundle names include pod ID and Date.now; remote bundle names
  include pod ID. There is no new transaction or rollback around a prior graft.
- Structured graft/transfer failures return false and preparation throws the
  domain error. Some transport rejections propagate as ordinary errors. Existing
  cleanup remains best effort; not every failed path promises zero mutation.

### Caller policy and error identity

- :482 defines the private ValidationWorkspaceReconcileError class. Manager catch
  branches at :14419 and :15673 use instanceof to distinguish it from ordinary
  transfer/infrastructure exceptions.
- triggerValidation at :14408 calls preparation only for non-sandbox pods. Sandbox
  pods take the verified checkpoint branch immediately above it.
- revalidateSession at :15648 calls preparation for every target after restarting
  the reused container. This is the live sandbox route into graft/bundle handling.
- A normal domain error blocks validation and is not sent to live file recovery.
  Ordinary failures may use tryRecoverAfterWorkspaceSyncFailure. Under forced
  revalidation, any preparation failure instead requeues validation-only work with
  the retained worktree and a fresh container.
- Attempt counts, event emission, compromised flags, recovery, requeue decisions,
  validation execution and cleanup belong to the callers, outside these helpers.

### Existing tests and primitives

- pods/pod-manager.test.ts:15262 covers live recovery before validation; :15309
  covers forced-resume reprovisioning; :15362 covers host-ahead reset ordering.
  :21652 covers verified sandbox checkpoint routing.
- worktrees/graft-reconcile.test.ts executes real Git for divergent trees, equal
  trees and a missing base. worktrees/sandbox-reconcile.test.ts uses independent
  object stores to exercise actual bundle transfer, upload failure and absent
  prerequisites. These are primitive tests rather than the complete manager wiring.
- workspace-preservation.test.ts, workspace-transfer.test.ts and their public
  characterization groups cover the two completed slices. Slice 2 passed 870
  affected tests and the full pipeline, as recorded in its completed plan.

## Architecture documentation

The newly extracted transfer factory already supplies syncWorkspaceBack. Validation
preparation composes that operation with host/container Git inspection, while its
manager callers own lifecycle decisions. Existing graft and transfer primitives
accept typed RunGit collaborators and return structured results.

## Historical context

The first two approved plans deferred validation reconciliation. Slice 2 ended at
1a2dd0c8 with no manual acceptance outstanding. The main checkout has concurrent
work; this research uses the existing isolated rewrite branch and leaves it alone.

## Related research

- 2026-10-17-pod-manager-workspace-preservation.md
- 2026-10-17-pod-manager-workspace-transfer.md

## Open questions

None about the mapped boundary. No new implementation or live Docker/Azure run
has occurred during this research.

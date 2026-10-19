---
date: 2026-10-19T00:52:33+02:00
researcher: Codex
git_commit: 8a08d5a4bb2ce22814b24e7b2739864789fb3396
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice27: delivery, PR creation/retry, merge queue and polling across manager/approval/validation"
tags: [research, codebase, pod-manager, delivery, merge]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice27 research: complete delivery and merge boundary

## Question and source baseline

Locate milestone27 across the current manager and previously extracted approval/
validation workflows, including the explicit validation-trigger size exception.
Current manager is7,399 lines at the pushed implementation above. Slice26 frozen qualification subsequently passed (see its plan/proof); no27 product change yet.
All manager line references below use packages/daemon/src/pods/pod-manager.ts at that
baseline. Existing source and complete snapshots/reference inventories are retained
in .autopod-data/delivery-merge/.

The roadmap assigns11 helper bodies, retryCreatePr, four bindings and the startup
resumeMergePolling call to27. Its additional explicit requirement covers inline
validation-trigger/revalidation delivery and the trigger's temporary1,273-line
exception. The Slice26 plan also records approval's inline delivery for27 review/
extraction. This responsibility therefore extends beyond manager helper relocation.

## Provider, queue and polling construction

prManagerFactory (:1091–1094) wraps the originally captured raw provider factory with
createDurablePrManagerFactory when a delivery ledger exists; otherwise it retains
the original factory reference. mergeQueue is the original new MergeQueue at:1380.
mergePolling (:1873–1875) is createPollingCoordinator with the original debug callback;
DEFAULT_MERGE_POLL_INTERVAL_MS (:1877) is60,000. Their current construction is separate
from the later poll helper declarations and startup invocation (:2857).

The same provider factory flows into fix completion, polling, push/create retry,
validation and approval. The same merge queue is used by fix delivery and the new
approval-workflow module as well as merge polling. mergePolling's current direct
manager uses are start/stop; cleanup callers use stopMergePolling. There is no new
per-consumer queue/coordinator instance. Original resource ownership/construction
must be accounted for in the next plan and final mutable-owner reconciliation.

## Current polling algorithm

startMergePolling (:2609–2840) captures current generation and installs a poll callback
on the original coordinator. Status/generation/PR/provider checks stop irrelevant
polls. An ownership closure combines coordinator identity, approval identity and
unchanged PR url; an operation wrapper rechecks before/after awaits, including errors.

A missing merge journal/entry parks failed with retained resources and stops. Status
lookup reconciles recorded source/target evidence before subsequent mutation. Closed
PR or an incompatible earlier admission is retained/parked. Safe pending admission
inspects retained source and can enqueue a source-bound merge when CI/review evidence
allows. Polling does not rebase or push over an admitted request. Reconciliation
errors update block reason and keep resources for another explicit observation.

Confirmed merged evidence precedes guarded cleanup, complete transition, completed
event, stop and dependents. Other pending results refresh block reason. Actionable
CI/review failures compare the latest feedback message before enqueueing and call
maybeSpawnFixSession through the original fenced operation. Poll interval is read
once from the bound profile, with original fallback. stopMergePolling calls the
original coordinator stop. resumeMergePolling lists merge_pending pods and starts
each poller; manager invokes it during construction before runtime credential and
workspace-transfer factory composition. Its fix/workspace/approval dependencies are
currently hoisted callbacks or already constructed references, not a public manager bag.

## Current scan, credentials and PR helpers

runPushCheckpointScan (:1565–1607) skips unwired/no-worktree scans, uses the original
base/profile/workspace context and emits bounded findings. Block throws the original
SECURITY_SCAN_BLOCKED error; escalate logs; non-Autopod scanner errors remain fail-open.
getLatestPushFindings (:1612–1623) reads the last persisted push scan or returns[] on
unwired/read failure. No new scanner/credential policy is implied.

parkOnCredentialFailure (:3285–3317) persists a host_push credential escalation and
awaiting_input transition, emits original service-specific repair text and retains
resources. ensurePrBaseBranchOnOrigin (:3436–3474) skips missing/same/default bases,
retains the worktree method receiver via bind, resolves original credentials and
logs best-effort base publication failures.

pushAndCreatePr (:3482–3595) enforces PR output, collected guidance and worktree/provider
availability. It resolves original base/credentials, pushes the feature branch with
zero deletion allowance, preserves credential error identity and wraps other failure
categories. PR creation gets the original refreshed metadata, security findings and
fallback reporting. retryCreatePr (:6936–6960) admits only validated/complete pods
without a PR and with a worktree, delegates push/create, then persists/emits the URL.
Its body has no this/deps access. Three static helpers retain exact conflict text,
series-aware base selection and single-PR-series predicate.

## Inline delivery still present in validation

validation-trigger-workflow.ts is1,273 lines. The pass branch calls screenshot
publication at:904, branch merge/push at:920, stats at:960 and PR create at:1010.
It computes provider-aware screenshot refs, retains existing PR urls, reads current
waiver/stats/summary metadata, ensures the base and reports fallback. Credentials park
and return; deletion guards can fail and return; other push failures rethrow. PR
creation errors leave the pod validated rather than changing that policy. Delivery
precedes validated/readiness/dependents/advisory publication and subsequent fix routing,
container stop and setImmediate auto-approval. Captured dependencies/type scaffolding
occupy part of the module; the existing Captured alias is:37–113. The size exception
is still real and explicitly assigned27 for review/reduction.

validation-revalidation-workflow.ts is682 lines. Its separate pass delivery calls
screenshots at:462, branch merge/push at:475, stats at:498 and PR create at:519.
Deletion allowance is always0 for this human-pushed worktree. It retains its distinct
credential/deletion error behavior and sends empty screenshot metadata to PR creation.
Validation/readiness/advisory/fix/auto-approval follows in original order. The earlier
credential lookup at:177 is part of update/pull setup, not this pass-delivery block.
These existing paths have overlapping operations but different current policies;
research records both without treating them as interchangeable.

## Inline delivery in approval after26

approval-workflow.ts is835 lines with the unchanged794-line approveSession lifetime.
Its local durable publication helpers call publishSource/CommittedSource at:73/88.
Snapshot collection at:122 precedes publication/cleanup. Existing merge reconciliation
runs through status:157, reconcileMerge:180 and retained-source inspection:188.
No-change branch classification calls stats:224; uncertain accumulated work preserves
publication. The main PR path uses the shared merge queue and source/target-bound
merge helper at:388, with repeated original lifecycle fences and review/status checks.
The no-PR retry ensures base:654 and creates PR:657 before review/merge admission.
The branch fallback and final cleanup/complete effects remain in this body. The
selected call inventory is broader than just PR creation and includes source/snapshot/
reconciliation boundaries; it is not a claim that every one belongs to the same helper.

## Existing evidence and constraints

The public manager file remains frozen at1,192 cases. The latest qualifying affected
set covers196 suites, including existing merge/publication/polling/readiness/snapshot
collaborators. New approval tests prove real local ledger admission with synthetic
transport evidence and retained/confirmed source across SQLite reopen. No live GitHub/
ADO/Docker/Azure/model acceptance follows from those local contracts.

Slice26 is fully qualified; the remaining goal includes all27–34 responsibilities. Fix
algorithms remain28, controls29, resource cleanup30, recovery/workspace31, admission32
and final composition/qualification33/34. Final facade<=1,500 lines and full327-unit/
73-member/mutable-owner reconciliation remain required. The delivery scope must not
be replaced by a sequence of helper-only milestones; original branch/PR, credential,
error, callback, publication, ownership and cleanup policies remain the source of truth.

## Exact manager inventory

| Symbol | Current lines |
|---|---|
| `formatRebaseConflictReason` | 269–273 |
| `resolvePrBaseBranch` | 491–497 |
| `isSinglePrSeriesPod` | 499–501 |
| `runPushCheckpointScan` | 1565–1607 |
| `getLatestPushFindings` | 1612–1623 |
| `startMergePolling` | 2609–2840 |
| `stopMergePolling` | 2843–2845 |
| `resumeMergePolling` | 2848–2854 |
| `parkOnCredentialFailure` | 3285–3317 |
| `ensurePrBaseBranchOnOrigin` | 3436–3474 |
| `pushAndCreatePr` | 3482–3595 |
| `retryCreatePr` | 6936–6960 |

The saved research inventory includes all four original initializer texts and actual
captured/live/receiver symbols, including shorthand values. inline-delivery-inventory.json
records selected boundary call lines and enclosing conditions in all three workflow
files. Full workflow, validation ports and polling coordinator snapshots are retained.

## Related artifacts

- ../plans/2026-10-18-pod-manager-remaining-roadmap.md
- 2026-10-19-pod-manager-approval-readiness.md
- ../plans/2026-10-19-pod-manager-approval-readiness.md

## Open questions

None about current responsibility/location. Next action: write the complete27 plan with manager state/helpers, all inline delivery surfaces,
startup dependency timing and the trigger size exception explicitly accounted for.

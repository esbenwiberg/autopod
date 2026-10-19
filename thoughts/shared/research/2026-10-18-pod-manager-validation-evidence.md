# Slice 10 research: post-validation evidence collection

Date: 2026-10-18.
Baseline: fa4f8abab07ee54147ec1b01d529ff3b745ce43a.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Existing boundary

Nine slices are complete. The manager is 17,511 lines. Ordinary triggerValidation
starts at packages/daemon/src/pods/pod-manager.ts:13276; manual revalidateSession
starts at :14532. The shared execution helper now lives in validation-execution.ts.
The manager still owns result finalization and delivery.

At :13534 ordinary validation initializes validationSyncOk=true. Pre-validation
sync can update it; false parks and returns before executing checks. After execution,
the manager releases its own validation controller, rejects a stale lifecycle at
:13592, and emits the finalizing activity at :13600.

The contiguous :13602–13723 region (122 lines including its trailing blank) computes
evidence gates, collects host facts, syncs the workspace, collects smoke screenshots,
then collects fact screenshots again. :13724 persists lastValidationResult. History,
token accounting, result events, terminal-status checks, independent councils,
correction, shutdown and delivery follow outside the region.

## Evidence gates and order

Three gates are computed before any collection or sync:
- Any relative screenshot attachment with case-insensitive .png extension.
- The same condition on a browser-test fact, for the pre-sync host pass.
- Any smoke page with a truthy screenshotPath.

The browser-test gate selects whether to call collectFactScreenshots, but that
collector visits ALL facts. It does not filter its pass to browser-test facts.
Computed gates are not recalculated after collaborator mutations.

The host fact pass requires worktreePath, its gate and screenshotStore. It emits
activity outside try, then awaits collection and logs count inside try. Its catch
warns and continues. This preserves files written directly into the host worktree
before syncWorkspaceBack mirrors container /workspace over that worktree.

Sync requires containerId and worktreePath, independently of screenshotStore.
It emits activity and reads Date.now before try. Sandbox checkpoint returns a
receipt; validationSyncOk becomes promoted && materialized && lineageVerified.
Even a false receipt emits the current successful-completion activity when no
exception is thrown. Other targets call factory.get(pod.executionTarget) and
syncWorkspaceBack; successful transfer leaves the incoming flag unchanged.
Caught sync errors set false, log warning and emit degraded-sync activity. Formatter
and successful completion activity are inside try, so their exceptions also follow
that catch. Throwing from catch activity/warning can escape to the outer manager.

Smoke collection requires worktreePath, smoke gate and store. hostScreenshotDir
is resolved only within this try and only for this pass. Each collected entry uses
Array.find to attach its ref to the FIRST matching original page. Duplicate paths
can therefore overwrite that first page and leave later pages unattached. Missing
count examines every page with screenshotPath and no screenshot. A warning/info
failure inside try can occur after result mutation; there is no rollback.

The final fact pass requires worktreePath, initial fact gate and store. Activity
uses the current sync flag. The collector mutates original attachment.screenshot
refs. It logs count or catches/warns. Result identity is retained throughout.

## Shared collaborators

Manager dependencies screenshotStore and hostScreenshotDir are destructured at
construction (:1943–1944). Changing those properties on the original deps object
later does not replace the captured references. Container factory method lookup
remains at sync time. formatElapsedDuration (:5662) returns seconds with one
fractional digit; preserving its manager-owned callback avoids an unrelated move.

collectScreenshots and collectFactScreenshots are imported only for this region
(:171–172); remove these manager imports when extracting. Other symbols from their
import declaration remain used by delivery. path is also used elsewhere.

packages/daemon/src/validation/screenshot-collector.ts owns filesystem containment,
symlink/regular-file checks, /workspace mapping, allowed host directory resolution,
filenames and per-file best-effort behavior. It catches per-file read/store errors.
It does not check PNG signatures. ScreenshotStore is defined in
pods/screenshot-store.ts and writes supplied bytes using temporary sibling + rename.
Store recreation can verify persisted bytes/refs without a container or provider.
These implementations and security rules are separate from manager sequencing.

## Downstream coupling and caller differences

The ordinary delivery path passes maxDeletions: validationSyncOk ? 100 : 0 to
worktreeManager.mergeBranch at :14187. Returning the flag from extraction must
preserve this link. Evidence errors alone do not change that flag. Missing evidence
is not a new blocking validation result.

Manual revalidation has its own sync/result flow; it does not execute this exact
collection region. There is no common caller to unify in this slice. The manager's
existing lifecycle guard precedes evidence collection; no new ownership assertion
exists between every await and persistence. A refactor must not claim stronger
stale-result protection or atomic persistence.

## Existing evidence

pod-manager.test.ts:14800–14964 pins finalizing → sync → result/shutdown ordering,
absent-store collection gates, and verified sandbox checkpoint behavior. Its sandbox
case intentionally sets archive extraction to fail after validation but checkpoint
receipt still succeeds; that is not evidence for an unverified receipt or sync failure.
New baseline cases are needed for actual evidence bytes/refs and degraded delivery.

Verified adjacent suites: validation/screenshot-collector.test.ts (host paths,
missing files, symlink escapes, names and ref mutation), pods/screenshot-store.test.ts
(roundtrip, ordering, names, delete and concurrent writes), and
validation/screenshot-artifacts.test.ts (delivery publication). Slice 9's explicit
48-file affected set exists under ignored .autopod-data/validation-execution/.

## Next action

Prepare the concrete extraction plan and illustrated HTML for approval. Planning
has not changed product code or run implementation tests. The established three
phases and prior authorization for incremental commits/pushes continue to apply.

# Exact-source adoption: foundation only

**Not yet an operator workflow. No HTTP/CLI operation is exposed, no current-source
validation is certified by these helpers, and no rollout/retry is authorized.**
The private checks-only path now uses the real revalidation workflow, but its
source-coordinator/real-backend binding, admission/cleanup fences, authenticated
API/CLI and supported ambiguity reconciliation remain work in progress. Do not deploy this checkpoint as a pod-recovery solution.

This is a bounded follow-up to retained-continuation/wakeup recovery. An advanced
remote branch cannot be approved using an old pass, force-pushed backwards, or
silently fast-forwarded while continuing to display historical validation.

## Implemented building blocks

- `219_source_adoptions.sql` and `source-adoption-repository.ts` provide immutable
  task/resource/source bindings, a single unsettled task claim, immutable audit
  events, monotonic phases and explicit human reasons. A repeated request ID
  observes only the same binding/actor/reason; it cannot admit different work.
- Custody/availability/delivery assertions are **library guards, not yet wired
  into production admissions or cleanup**. Historical resources remain held in
  this journal even after pointers change or checks succeed. There is no expiry,
  waiver, deletion permission, grant or counter reset. Existing task accounting
  is read, never rewritten.
- `source-adoption-preservation.ts` captures host and retained `/workspace`
  independently, including ignored binary reports and installed dependencies.
  There is no exclude list. Host source/copy fingerprints must agree before and
  after copying. Both snapshots must pass the existing generation/cycle/path/
  content/mode receipt verification. A stale/partial copy is never published as a
  complete snapshot. Originals are never killed or deleted by this helper.
- Private archives require a fresh namespace disjoint from the original workspace
  (neither ancestor nor descendant); indirect symlinks are checked before mkdir.
  An existing archive directory is never reused/chmodded. The archive root is
  mode0700. Container export carries ownership/abort guards across SDK awaits. Symlinks are preserved as links, **not proof that their external
  targets were archived**. Reports outside `/workspace`, provider snapshot copies
  and global dependency caches are not certified here. Original resource custody
  is still necessary. Existing receipt bounds remain100,000 files/links,
  100,000 directories and1GiB; oversized capture fails closed without exclusions.
- `source-adoption-git.ts` and the optional `WorktreeManager` methods pin an exact
  remote branch head in an isolated reference namespace. Production preparation
  verifies the authenticated remote repository identity. Unexpected remote
  movement, dirty/untracked source, hidden index flags/sparse source, submodules
  and non-fast-forward ancestry are refused, not repaired automatically.
- A full Git bundle preserves both old and target history and has a streamed
  SHA256. Completed bundles are published atomically without replacing existing
  evidence. Its references are not publication receipts. A fixture independently
  reconstructs both trees from that bundle. Preparation never changes HEAD or
  workspace files. Application requires matching pinned references/bundle and
  uses a local fast-forward with hooks/autostash disabled and
  `--no-overwrite-ignore`: it refuses ignored-report collisions rather than
  overwriting them. There is no hard reset, clean, auto-commit, rebase, push,
  branch retarget or provider PR merge.

## Private checks integration (not an exposed recovery operation)

`validation-revalidation-workflow.ts:revalidateAdoptedSource` accepts only a
checking-stage durable admission with original task/resource/source bindings and
an already-invalidated current result. It refuses native Goals, phase skips and
waivers, requires source-bound dependency preparation, and claims one invocation
before external awaits. Migration220 records that claim immutably: **not a
worker start, backend dispatch, termination or usage receipt**. A second caller
or daemon restart cannot replay it. Normal revalidation refuses existing source
custody rather than pulling/reconciling a branch behind the source protocol.

The private path does not pull, graft/reset/auto-commit, wake a stopped resource,
replace a missing one, reset attempt history, consult old review batches or
pre-submit passes, waive failures, publish source/screenshots, trigger dependent
work or approve/merge. It calls the existing validation execution/retry machinery;
no permission/grant or task-wide budget reset is manufactured. Setup execution
must actually pass before an overall pass is accepted. The admitted setup command
is immutable source-operation input (or the frozen configured command), not a
claim that arbitrary dependencies were cryptographically certified.

Ownership is rechecked after successful AND rejected awaits. The coordinator's
real-source verifier runs before preparation/checks and after execution, and the
actual validation invocation is rechecked again after that last asynchronous
verification. Only then may canonical result publication happen. Returned results
are retained as explicitly **unaccepted** observations before certification, so
source drift cannot silently destroy execution evidence or become a current pass.
A provider404 never clears the original resource pointer in this path. No
controller is yet exposed that can supply this capability on a real pod.

## Required before exposing it

1. Bind actual lifecycle/generation/resource namespace, physical worktree,
   launch/provider/profile/contract,
   branch/base/repository and both live source identities. Enforce pending
   decisions/guidance, quiescent Git state, original worker/validation termination
   and native-Goal restrictions before any mutation. Lease all competing admissions, pauses,
   delivery and cleanup; labels and saved DTOs are not ownership proof.
2. Wake only the exact retained resource through the existing durable wakeup
   protocol. Legacy stopped resources and pre-journal unknown operations remain
   blocked. No replacement worker, clone or speculative repeated restore.
3. Verify complete old host/container snapshots and the bundle before changing
   files. Atomically journal mutation admission, advance the ownership epoch and
   invalidate canonical current validation without erasing historical results,
   approvals, unknown usage or task-wide retry/budget history.
4. Apply only the requested pinned source to both workspaces. Journal container
   mutation dispatch/observed exit. Lost transport or crash during application
   keeps custody and requires observation; never blindly replay in-place writes.
5. Admit **real** current-source checks through existing retry/execution ledgers.
   Pin source throughout, verify configured dependency preparation and fresh
   review, skip ordinary remote pulls/grafts/auto-commits, and verify exact clean
   source before publishing a result. No old-pass/prior-review substitution,
   coding worker, bypass, publication, dependent trigger, approval or merge.
6. Preserve original PR target/no-merge instructions. A checks pass cannot release
   delivery or report custody. A factual exact-source external delivery receipt
   is a separate observation, not permission to merge an open PR.
7. Provide authenticated durable status and narrowly supported reconciliation.
   No elapsed-time lease release, fake exit/usage, implicit waiver or task-wide
   budget reset. Implement audited report inventory/hold release separately.

Tests exercise the library protocol and real temporary Git/filesystem fixtures;
they are not live Azure/Docker execution, actual pod source adoption, fresh
validation, full dependency closure or end-to-end report-preservation evidence.

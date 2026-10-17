# Slice 3: validation workspace extraction

Status: READY FOR REVIEW — implementation has not started.
Baseline: 1a2dd0c8a82db8e16f36c0849e91945e101e75e1.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract workspace preparation before validation, following the same accepted
three-phase structure as slices 1 and 2: characterize, extract, qualify.
The user requested the next slice. This concrete plan is ready for explicit
approval; previous slice approvals do not authorize its implementation.

## Current state analysis

See ../research/2026-10-17-pod-manager-validation-workspace.md.
Source references below use packages/daemon/src/ at baseline 1a2dd0c8.

pods/pod-manager.ts:5500–5942 contains eight inspection/reset/reconciliation helpers.
ValidationWorkspaceReconcileError at :482 is recognized by manager catches at
:14419 and :15673. Two entry points differ deliberately: normal sandbox validation
uses verified checkpoints, while revalidation invokes preparation for all targets.
The existing graft/bundle primitives already have real Git tests.

## Desired end state

- createValidationWorkspace composes the extracted transfer callback and existing
  Git primitives; prepareWorkspaceForValidation retains its current signature.
- Manager callers retain routing, lifecycle, validation execution, recovery and
  requeue decisions. Their instanceof checks use the same exported error class
  that the new module throws.
- Existing behavior is characterized before movement and checked unchanged after.
- The complete module is exercised with real local Git repositories, including
  independent sandbox object stores and actual bundle bytes/fetch/reset.

## Scope and non-goals

Exactly two product files: new pods/validation-workspace.ts and existing
pods/pod-manager.ts. Test changes: pods/pod-manager.test.ts and new
pods/validation-workspace.test.ts. Update this plan with observed evidence.

No change to workspace authority, dirty-file decisions, ancestry interpretation,
checkpoint routing, validation attempts, lifecycle, retry/cancellation, graft or
bundle algorithms, cleanup guarantees, credentials, schemas, profiles, APIs,
dependencies or unrelated checkout work. No deployment, real pod, PR or main merge.
Do not add rollback or serialization while mechanically moving this boundary.

## Implementation approach

Create a typed factory:

    createValidationWorkspace({ logger, syncWorkspaceBack })
      -> { prepareWorkspaceForValidation }

Dependencies:
- logger: Pick<Logger, 'info' | 'warn'>.
- syncWorkspaceBack(containerId: string, worktreePath: string,
  cm: ContainerManager, podId: string, executionTarget: ExecutionTarget):
  Promise<{ pushed: boolean }>.

Returned operation keeps its exact current positional signature and Promise<void>.
Keep ContainerManager and ExecutionTarget as existing domain types. Infrastructure
is passed per operation; no Pod, repository, manager, state transition or service
registry is a dependency.

Move these eight functions unchanged into the factory:
readHostWorktreeHead, readHostWorktreeStatus, readContainerWorktreeHead,
readContainerWorktreeStatus, isAncestorInContainer, resetContainerWorkspaceToHead,
reconcileDivergedSandboxWorkspace and prepareWorkspaceForValidation.

Move and export ValidationWorkspaceReconcileError from the same new module,
retaining its constructor and name exactly. Import that single class into the
manager for both existing instanceof checks. Do not substitute a name-string check,
wrap every infrastructure error, or leave a duplicate constructor behind.

The new module imports existing deriveBareRepoPath, graftHostTreeOntoBase and
transferCommitToContainer. Their source is unchanged. Retain manager imports that
still serve provisioning or other callers; remove graft/bundle imports only when
no remaining use exists. Compose the factory immediately after transfer composition.
Retain both preparation call sites and all their surrounding branches.

Compatibility details:

- Four observations remain concurrent and retain exact null/empty handling.
- Equal HEADs + definitely clean container: no synchronization, even if host is
  dirty/unknown. Dirty or unavailable container status still selects sync.
- Preserve ancestry probe ordering, exit 0/1/other meanings, transport rejection,
  reset --hard followed by clean -fd, and all timeouts/log fields/messages.
- Missing HEAD invokes existing transfer. Container ahead invokes transfer. Host
  ahead invokes reset/clean without adding a dirty-status guard.
- Ordinary triggerValidation keeps verified sandbox checkpoint routing. Human-fix
  revalidation continues to invoke preparation for sandbox and local targets.
- Keep the distinction between domain reconciliation errors, ordinary transport
  failures, live recovery, and forced revalidation's validation-only reprovisioning.
- Preserve object-availability and alternates guards, staging ref names, host-side
  target selection, graft-before-transfer ordering, equal-target fast return,
  bundle bytes and cleanup attempts. A failed transfer can follow a completed
  graft; do not claim rollback or no host mutation on failure.

## Phase 1: characterize the existing public validation paths

### Changes required

Only pods/pod-manager.test.ts. Add a named 'validation workspace compatibility'
group using its existing context and controlled host/container Git boundaries.
Reuse existing cases when they already pin the same behavior. Do not add product
seams or import the future module to establish the baseline.

Cover these groups:

1. Missing/blank/unreadable host or container HEAD selects sync. Status read errors
   remain null; equal-HEAD cases distinguish clean, dirty and unavailable container
   status, including dirty/unavailable host status that alone does not force sync.
2. Container ancestor of host selects reset then clean, with exact command/timeouts,
   before validation/diff reads. Host ancestor of container selects sync-back.
3. Local divergence blocks validation and marks the existing compromised path,
   without live extraction recovery. Non-0/1 ancestry results retain null behavior;
   rejected ancestry transport retains the ordinary-error recovery path.
4. Reset/clean nonzero exits preserve domain classification; transport rejection
   preserves ordinary classification. These are observable manager decisions,
   not just private helper return values.
5. Ordinary sandbox triggerValidation uses the verified checkpoint route. Sandbox
   revalidateSession still reaches reconciliation; use pullBranch.newCommits=true
   for non-forced human-fix cases so the existing admission guard allows execution.
6. Sandbox reconciliation success, missing-object path validation, mismatched
   alternates, refused import, graft failure, bundle/upload/fetch failure and
   reset/clean failure preserve existing success/failure and cleanup behavior.
   Use the existing Git/ContainerManager seams to drive real helper control flow.
7. force=true revalidation failure requeues with skipAgent and retained worktree,
   without running validation or parking a newly compromised worktree. Non-forced
   domain and ordinary failures retain their different recovery behavior.

Assert material outcomes: validation admitted/blocked, retained source/resources,
flags/status/requeue options, reset/sync selection and cleanup. Close every new DB,
join held operations, restore spies/timers and clean private temporary files.
Freeze baseline source/test identities and retain logs under ignored evidence.

### Success criteria

Automated:
- [ ] New public cases pass against unchanged production source at recorded baseline.
- [ ] Existing stale-container, recovery, force-resume and checkpoint cases pass.
- [ ] New fixtures dispose databases, temporary resources and async work.
- [ ] Product identity and before-test hashes/logs are recorded.

Manual: None required for this headless compatibility boundary.

## Phase 2: extract and prove the material reconciliation boundary

### Changes required

Apply the two-product-file movement above and add validation-workspace.test.ts.
Keep Phase 1 assertions byte-identical. Compare all moved bodies and the remaining
manager against the planned construction, allowing only imports, exports, factory
composition and formatting. Review shared imports and the single error identity.

Use real temporary local Git fixtures, private Git configuration and the shared
mock ContainerManager factory with narrowly mapped private paths. Exercise actual
production Git commands and bundle bytes. Keep original graft/bundle implementations.
Use canonical fixture paths on macOS. Isolate host/container temporary bundle paths
inside private fixture directories and clean them in finally, even on failed tests.
No Docker server, provider or external repository is required.

Direct boundary evidence:

- Equal clean HEADs perform no transfer/reset; divergent local histories produce
  the exported domain error and retain their actual refs/files.
- A local host-ahead case resets/cleans the container to the existing host commit;
  a local container-ahead case composes the actual transfer factory and preserves
  host Git linkage and source contents, rather than returning a fabricated result.
- True sandbox divergence uses isolated object stores. Establish that container
  cannot resolve the host target before transfer. Run the complete prepare method:
  graft, create/copy/fetch bundle, reset/clean. Assert resulting target parent equals
  original container HEAD, resulting tree equals original host tree, expected file
  bytes materialize, host/container agree, and temporary bundles/refs are removed.
- Host-ahead sandbox with a host-only commit must transfer the missing object before
  reset. Verify actual resolvability before/after and retain original host target.
- Equal-tree reconciliation returns the existing container target without an empty
  commit or unnecessary bundle/reset.
- A rejected upload/fetch leaves validation preparation failed and never resets to
  an unavailable target. Verify the cleanup that this exact path guarantees. If
  graft already changed host history, report/characterize that existing state;
  do not assert or implement rollback.
- Missing host object plus mismatched container alternates cannot push into an
  unrelated repository. Assert unrelated refs unchanged and no invented authority.

No test may count a shared alternate object store as proof of isolated-store bundle
transfer. Keep public caller characterization as the error/routing compatibility
oracle. Primitive tests alone do not establish complete module composition.

### Success criteria

Automated:
- [ ] Identical public characterization passes after movement.
- [ ] Actual local Git, isolated object-store and bundle outcomes pass.
- [ ] Error identity is shared and manager lifecycle policy stays outside the module.
- [ ] Movement receipt confirms exact scope and unchanged existing primitives.
- [ ] Final product diff contains only the two approved product files.

Manual: None required. No live Docker/Azure qualification is claimed.

## Phase 3: qualify the final source and record evidence

Use the existing ignored Node 22.23.3 / pnpm 9.15.4 npx launcher from slices 1/2.
Verify actual child runtime and an opened SQLite memory database. Store evidence
under .autopod-data/validation-workspace/; keep prior slice evidence intact.

From the isolated worktree with the pinned launcher on PATH:

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation workspace compatibility'

Run both primitive suites plus the full previous affected set and the new module:

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-workspace.test.ts src/worktrees/graft-reconcile.test.ts src/worktrees/sandbox-reconcile.test.ts src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts

    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-workspace.ts packages/daemon/src/pods/validation-workspace.test.ts
    git diff --check
    TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Freeze final product/test/script hashes before qualification and compare after.
Record actual commands, exit statuses, counts, skips, failures and limits. Review
final diff, commit/push verified increments under repository instructions, and
confirm the remote branch matches the final commit. Do not relabel an unrun or
failed gate as passing or create a deployment/PR as a side effect.

### Success criteria

Automated:
- [ ] Affected suites pass with SQLite explicitly included.
- [ ] Full uncached install/lint/build/typecheck/test/audit/secret pipeline passes.
- [ ] Source identities, before/after results, runtime and skips are recorded.
- [ ] Diff review confirms compatibility scope and unchanged primitives/caller policy.
- [ ] Validated commits are pushed and remote identity confirmed.

Manual: None required. Approval authorizes all three phases together with no
intermediate human gate; final acceptance is the recorded local compatibility proof.

## Testing strategy and limitations

Public characterization protects routing, shared error identity and lifecycle
interpretation. Direct real Git tests protect material target selection, graft,
object transfer and reset. Existing primitive and prior slice suites protect their
unchanged algorithms and composition. No live Docker/Azure, process-death, new
atomicity or cross-process synchronization guarantee is established.

## Performance considerations

One factory replaces the existing closure functions. Preserve observation
concurrency, timing, command budgets, Date.now evaluation and cleanup order.
No added I/O, retries or speed claim.

## Migration and rollback

No schema, API, stored-record, configuration or profile migration. Revert the new
module and manager imports/wiring together. No database rollback is needed.
Integration with concurrent main-branch work remains a separate integration step.

## References and next action

- Research: ../research/2026-10-17-pod-manager-validation-workspace.md.
- Predecessor: 2026-10-17-pod-manager-workspace-transfer.md (complete).
- Existing primitives: worktrees/graft-reconcile.ts and worktrees/sandbox-reconcile.ts.

Next action: obtain approval of this concrete slice 3 plan, then implement all
three phases. No implementation check is complete or claimed as passing yet.

# Slice31: complete workspace and recovery ownership

Status: PLANNED — implementation is the next authorized phase.
Date:2026-10-19. Qualified source:c00a32d0871721658ef22019955109f478bc3e0c.
Documentation baseline:a5f98e7fe16a473f59f8da1acc8d3a1c16235e78.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-workspace-recovery.md.

## Outcome and authority

Move all27 named complete bodies, the complete resolveBranchSource arrow and allnine
original binding initializers assigned31. Fifteen public workspace/recovery commands
become thin delegates. Preserve actual async lifetimes, immutable/legacy admission,
actor/credential/error behavior, receiver timing and per-instance state identity.
Manager starts at4,447lines with73 public members. No helper-only subset completes31.

The standing goal “the rest of the slices” authorizes research→concrete plan→implement→
qualify and commit/push checkpoints without repetitive per-slice confirmation. The
user requested resuming on2026-10-19; reinspection finds a clean pushed30 checkpoint
and all2,137 package/script plus six root hashes matching. The goal tool still reports
blocked, but no current repository/code blocker is present. This plan and subsequent
implementation stay within the standing approval; automatic runner status is controlled
by the app/user, not inferred from this document. Previous turn completed30; this turn
advances31. Four milestones31–34 remain until31 is fully qualified; full goal stays
unfinished through34's facade/inventory/regression finish line.

No migration/profile/state/dependency/API-policy change, new recovery retry, stronger
termination/replay/atomicity guarantee, live provider/Docker/Azure effects, real external
messages, PR/main integration or deployment. Existing native fix alias limitation from28
and original timeout/late-operation behavior remain.32 retains admission/query/series
algorithms called through narrow original ports;33 finishes facade/dependency composition.

## Resolved source constraints

Only completeSession, fixManually and startStuckPodWatchdog use dynamic this. Their
sets are respectively(promoteToAuto,revalidateSession), (createResolvedSession,
createSession), and(killSession,cleanupPodResourcesForRecovery). Explicit narrow this
annotations and .call(this,...) delegates preserve actual properties inside later
coordinated, detached and event callbacks. No bound copy of those methods at construction.

Live dependencies remain live: evidence eventRepo/providerAttemptRepo; infrastructure
backoff/requeue/enqueue; promotion/manual-fix/watchdog launchConfiguration; completion
getSecret; observation eventRepo. Other services retain original capture. Constructors
must not invoke service callbacks or start timers/listeners. Original maps, coordinator
and force-lease Set remain shared; no parallel tracker or copied semaphore/map state.

Research wording correction: runDeletionCleanup has one25s whole-operation deadline,
not25s per stage. The current imported implementation checks performance.now against
that common deadline before/after each stage and invalidates later stage admission on
timeout. Preserve it exactly. Stop-watchdog clears interval/subscription but does not
drain already dispatched work; host-fetch timers clear on replacement/fire. No new
cancellation/serialization or stronger recovery guarantee is introduced.

## Sixteen new source modules

All paths are packages/daemon/src/pods/. Each new source file stays below1,000lines.
Only pod-manager.ts changes among predecessor package/script files.

1. workspace-contracts.ts: move exact public PodCreator interface, re-export it from
   manager for unchanged consumers. Add WorkspaceCompletionResult matching the existing
   inline public result(pushError/promotedTo). Keep public signatures unchanged. Define
   observed explicit captured/live/receiver interfaces using existing domain types,
   never PodManager/PodManagerDependencies or broad manager bag.
2. workspace-recovery-state.ts: createWorkspaceRecoveryState at the original consecutive
   maps/coordinator site, with identical infrastructureResumeRuns/artifactResumeRuns/
   artifactCompletionRuns initializers and coordinator runtime call. Replace only the
   coordinator's type argument Awaited<ReturnType<PodManager['completeSession']>> with
   WorkspaceCompletionResult. Prove equivalent structural result and identical erased
   runtime initializer; do not claim token-identical type syntax for this one binding.
   createWorkspaceLeaseState creates the original forceWithLeaseAllowances Set at its
   original later location. Both factories return original instances.
3. workspace-host-fetch-retry.ts: owns original retry timer Map and whole schedule body.
   Construct at old map site. The activity callback is initialized later; pass an exact
   two-argument lazy forwarding callback so construction does not read its uninitialized
   binding. Captured enqueueSession remains the original capture. Preserve30/120/300s,
   retry identity/not-before admission, replacement cleanup, deletion-on-fire and unref.
4. workspace-infrastructure-recovery.ts: export unchanged sandboxInfrastructureFailure;
   factory returns full hasDurableAgentExecutionEvidence/tryRecoverTransientSandboxFailure.
   Compose after createCompletionEvents, before all consumers in continuation/agent
   factories. Provider/resource callbacks are then initialized. Same live event/attempt
   reads, ledger/backoff admission, skipAgent exception, generation fencing, confirmed
   cleanup and queue-safe original fallback. Constructor only captures references.
5. workspace-branch-source.ts: owns the complete original resolveBranchSource arrow
   initializer in an effect-free factory at its original site. Retain standalone/single
   series ownership, matching-PR preference, deterministic fallback, logging/errors.
6. workspace-fences.ts: whole handleDeletionGuardError, ownsArtifactCompletion,
   failInteractivePreservation, failBranchPreservation, assertInteractiveCompletionCurrent
   and parkOnWorktreeSyncFailure. Compose immediately after createApprovalReadiness,
   before createDeliveryPr first captures the guard. All required event/transition/
   activity/approval callbacks exist then. Internal helper references stay in one
   factory; original conditions/defaults/errors and event/activity ordering remain.
7. workspace-preservation-recovery.ts: whole preserveSandboxAfterAgentFailure and
   tryRecoverAfterWorkspaceSyncFailure. Compose after createWorkspacePreservation,
   before createCompletionOwners first captures recovery. Preserve existing imported
   transfer/checkpoint/preservation algorithms through narrow captured callbacks.
8. workspace-promotion.ts: complete promoteToAuto with narrow live prepareWorker port.
   Retain native frozen worker handoff and legacy profile/instruction/skip-agent policy.
9. workspace-completion.ts: complete223-line completeSession with narrow receiver and
   live getSecret port. Original coordinator, preservation/scan/push/cleanup/transition,
   PIM import, linked revalidation and every await/failure/generation check stay inside.
10. workspace-branch-sync.ts: complete syncWorkspaceBranch. Same module-scope promisify
    binding and git listing, explicit document commits, host credentials, push/error
    results. Do not unify its policy with interactive completion or touch worktree
    implementation. No constructor Git call.
11. workspace-recovery-commands.ts: complete preserveWorkspace, quiesceSandboxAgent,
    suspendSandboxForRecovery, cleanupPodResourcesForRecovery and recoverWorktree.
    Preserve exact PID script, strict sidecar/network order, checkpoint proof, local
    extraction/guarded commit and safe restore fallback, blockers and errors.
12. workspace-manual-fix.ts: complete fixManually with narrow dynamic create methods and
    live frozen admission. Actor/creator/task/instruction/source-binding and cleared
    derived metadata remain exact. Existing canonical admission is called, not copied.
13. workspace-deletion.ts: complete deleteSession with actual deletion ownership claim,
    configuration hash, common25s deadline, seven original stages and metadata retention.
    Capture actual pending update intent/force-lease instances; claim.finish remains the
    final delete. No stage-specific retry or new receipt algorithm.
14. workspace-escape-controls.ts: complete forceComplete/kickPod with original actors,
    state admission, queue-entry clearing, validation abort, bounded cleanup and dependent
    advancement. Preserve intentional admin-override behavior and retained stopped container.
15. workspace-artifact-observation.ts: complete read-only getArtifactResumeObservation,
    using live event repository, actual shared run maps and existing termination/guidance
    guards. Status projection never executes recovery; unavailable remains fail-closed.
16. workspace-watchdog.ts: owns original null interval/unsubscribe state and complete
    start/stop bodies. Construct at their original site; all captured resource/activity
    callbacks already exist. Start takes narrow explicit this, preserving lexical use
    in wake/reconcile callbacks. Retain thresholds/liveness/wake grace/dedupe/republish,
    original overlapping async ticks and stop behavior. Constructor starts nothing.

Compose promotion/completion/sync/recovery/manual/deletion/escape/observation owners
before public return, after existing captured callbacks are initialized. Fifteen public
bodies retain signatures/defaults; promise-returning delegates return original owner
promises, void watchdog delegates invoke without a void return expression. Existing
startup delivery polling, completion/approval/fix composition and shared map captures
must remain valid at every intermediate revision. No cyclic manager import is allowed.

## Phase1: verified baseline and complete recipes

Verify30 PROVEN proof,2,137 package/script hashes/six roots and unchanged public bytes.
Save full manager,27named bodies/defaults, branch arrow, nine initializers, PodCreator,
complete captured/live/receiver references, constructor ordering and all17full source
recipes. Public report reuse requires matching qualified source/test provenance.
Allowed transforms: imports/exports/narrow types/factory scaffolding/delegates, original
instance wiring, explicit this and the documented coordinator type-only substitution.
No original body/default/runtime initializer/await/error-policy changes.

Automated:
- [ ] Qualified source/root/public provenance and complete baseline capture match.
- [ ] Whole bodies/arrow/bindings/type/reference/construction/source recipes saved.
Manual:none for bounded compatibility under standing grouped approval.

## Phase2: complete ownership and meaningful boundary proof

Implement all sixteen source modules and manager wiring. Add co-located direct suites
for state, host retry, infrastructure recovery, branch source, fences/preservation,
promotion/completion, document sync, recovery commands, manual fixes, deletion, escape
controls, observation and watchdog. Shared test-utils/workspace-recovery-helpers.ts
reuses actual native SQLite/repository/ledger infrastructure and existing controlled
adapters. All predecessor assertions/helpers remain byte fixed.

State tests prove same map/Set/coordinator identity at consumers and per-instance
separation; in-process same-request coalescing/conflict/failure cleanup. Timer tests
prove retry30/120/300s, original matching admission, replacement/fire cleanup and no
owned leftover timers after controlled runs. Infrastructure tests use real startup/
attempt ledgers for durable evidence and skipAgent distinction, retry exhaustion,
unconfirmed kill, superseded generation/container, queue-safe live fields and fallback.

Fences/preservation test queued guidance/unanswered decisions/replacement identity,
original error identity, artifact/generation allowances, side-effect ordering and
retain-before-cleanup. Promotion covers frozen and legacy inputs, profile switch and
instruction replacement. Completion uses actual coordinator and native repositories
for artifact failure retention, successful sync/guarded push, default-branch refusal,
returned pushError/worktree preservation, ownership supersession, PIM callback limits
and deferred linked receiver replacement. No live PIM/provider call.

Sync uses disposable local files/Git for actual Markdown/contract path selection and
controlled host transport, preserving unrelated staged code and no cleanup on sync
failure. Recovery covers exact sandbox quiesce/stop capability, strict auxiliary cleanup,
actual checkpoint proof inputs, local extraction/commit/restore branches and blockers.
Manual-fix tests actual frozen derive/admission where practical plus legacy ports,
actor/creator propagation and receiver replacement. Existing missing-alias native fix
limitation remains explicit rather than repaired or hidden by fixture selection.

Deletion uses actual native deletion claim/step receipts and shared Sets, testing
common25s timeout, failed stage/no later effects, retained row/metadata, replacement
lifecycle/configuration, settled retry and successful final delete. Escape controls
cover state/actor, stale queue entry, abort/stop and dependent progress. Observation
proves unavailable on active work/missing evidence and no recovery execution. Watchdog
proves idempotence, freshest liveness/interactive exclusion, stale running stop/failure,
wake grace, timestamp dedupe, dynamic reconcile callbacks, subscription/interval stop
and original pending-work limits. All pending controlled operations settle.

At least four actual private-file SQLite close/reopen cases cover completion/preserved
failure, frozen promotion/manual-fix configuration, durable deletion receipts/row outcome
and retry/recovery evidence. Check integrity/FK and unrelated rows. Use real local Git/
files/repositories where they are the claimed boundary; external effects are controlled,
without stronger restart/replay/termination claims inferred from mocks.

Run unchanged1,192public cases, all new direct suites and all46inherited direct resource/
operator/fix/delivery/approval suites plus missing immediate workspace/recovery/ledger/
coordinator/reconciler collaborators. Build daemon/dependencies/declarations; scoped
Biome/whitespace; zero new-test/fixture semantic diagnostics; compare changed-source
semantic cases to complete original manager baseline. Retain first failures and correct
scaffolding/fixtures without weakening original assertions or unrelated policy repairs.

AST audit all27named bodies/parameters/defaults plus branch arrow, eight token-identical
initializers and the coordinator runtime initializer with only equivalent type substitution,
PodCreator protocol, all17full recipes, shared original state/construction/startup and
73public members/fifteen thin delegates/three receiver paths. Other2,136 predecessor
package/script files and six roots stay fixed. All new sources<1,000lines.

Automated:
- [ ] Whole body/default/arrow/binding/type/full recipes and construction audit pass.
- [ ] Same73public members/fifteen delegates/three dynamic receivers/live fields pass.
- [ ] Public1,192 names/statuses/assertion bytes and direct boundary cases pass.
- [ ] Four actual SQLite reopens, retained failures and owned state cleanup proven.
- [ ] Build/lint/whitespace/semantic comparison pass without new diagnostics.
Manual:none for bounded local extraction; live external acceptance separately scoped.

## Phase3: frozen qualification and next responsibility

Expand all253 inherited affected suites with new paths and missing workspace/recovery/
artifact/deletion/coordinator/host-fetch/watchdog/ledger collaborators. Deduplicate and
save the unfiltered command before running with SKIP_DB_TESTS=0. Freeze final source/
root hashes, commit/push implementation, then run:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable local npx launcher, frozen install
without fallback/lock mutation and all groups uncached. Only inherited2MiB root-lint
processing allowance/82warnings; no rule/config/dependency/selection relaxation. Record
actual delta from30's8,949passes/572files/35Node tests and same ten gated cases, no new
skips.30's inherited100ms assertion once measured99ms; retain any observed failures,
recheck unchanged source honestly and do not silently adjust its threshold.

Apply prove-work to final implementation and save claims/results/commands/revision/
hashes/limits in .autopod-data/workspace-recovery/proof.json. Research32 while source
stays frozen. Mark31 complete in plan/roadmap only after all gates; commit/push docs and
verify clean local/remote identity. Then three milestones32–34 remain. Full objective
requires<=1,500line composition/delegates,327unit/73member/mutable-owner reconciliation
and34's final frozen uncached clean pushed qualification. No merge/deployment implied.

Automated:
- [ ] Expanded SQLite-enabled regression passes with no new skip.
- [ ] Full frozen uncached pipeline passes with actual runtime/count/gate evidence.
- [ ] Proof/frozen hashes/clean pushed revision verified.
- [ ] Plan/roadmap mark31 after proof; complete32research saved.
Manual:none for bounded scope; integration/deployment are separate actions.

## Compatibility and rollback

No migration/API or product-policy change. Original bodies/awaits/error identities/
receivers and runtime initializers persist; only one coordinator type argument changes
to an equivalent domain result type. PodCreator keeps its public import path via
re-export. Original mutable state remains per manager at original construction sites;
callbacks passed before their binding is initialized stay lazy with exact arity.
Constructors add no remote work/timers/listeners. Revert manager and sixteen owners
together. No unresolved design choices remain.

---
date: 2026-10-19T00:13:00+02:00
researcher: Codex
git_commit: 2e4ef206f716590fba4f02844741816a2aa856f9
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 25: completion composition, transitions and operator failure reporting"
tags: [research, codebase, pod-manager, completion]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice 25 research: completion and shared transition boundary

## Research question and baseline

Locate the complete milestone25 responsibility after provisioning and agent execution
are extracted: completion entry/composition, shared status/event effects, termination/
guidance checks and operator failure reporting. This documents current source and
existing owners. It does not prescribe an implementation or change product policy.
The Slice24 implementation above is pushed; its full frozen qualification subsequently passed (see the Slice24 plan/proof). The manager currently has8,812 lines.

All manager references below use packages/daemon/src/pods/pod-manager.ts at that
baseline. The original canonical roadmap assigns15 function bodies, one constant
and the original OperatorFailurePhase alias to25. Related completion owner factories
already exist and are composed in the manager. Source snapshots/reference inventory
are saved in .autopod-data/completion-orchestration/.

## Current completion entry and ownership

handleCompletion (:4962–5009) reads the pod and current immutable launch. A native
Goal requires achieved state and confirmed execution termination. Terminal/advanced
statuses return before human/source/output effects. Human-work gating runs before
artifact/source classification. Its optional promise is awaited only when present.

Artifact output is coalesced by pod id, lifecycle generation and finalization cycle.
artifactCompletionRuns remains the original manager map (roadmap31); a matching
in-flight promise is reused. A new promise defers finalizeArtifactPod into a microtask.
The finalizer deletes the map entry only if it still matches that same promise.

Other output modes await prepareSourceForCompletion. An undefined preparation result
returns without decision/validation. A prepared result passes to applyCompletionDecision
with a callback that reads this.triggerValidation at callback invocation. This is the
entry's only dynamic receiver member. Its only live manager dependency is
launchConfiguration; the other dependencies are captured original owner functions,
map and artifact finalizer. Artifact algorithms remain in previously extracted
artifact modules and existing finalizer composition.

## Existing complete domain owners

The manager composes three existing factories consecutively at :3358–3399, after
workspace preservation construction:

- completion-human-gate.ts (94 lines), createCompletionHumanGate, returns
  holdCompletionForHumanWork. Pending questions settle the completion journal,
  preserve source where possible and retain resources/waiters. Queued guidance
  records preservation success/failure, rechecks artifact/lifecycle ownership,
  atomically marks awaiting-human and fails the pod with retained guidance. No
  pending work returns undefined synchronously.
- completion-source.ts (291 lines), createCompletionSource, returns
  prepareSourceForCompletion. Sandbox delivery requires promoted/materialized/lineage-
  verified checkpoints and canonical diff proof; missing proof parks work. Local
  source sync and recovery precede auto-commit; unsafe sync/push clamps deletion
  allowance. Deletion guard can trigger container recovery and a guarded retry.
  Diff-stat failure is logged; an original source preparation object is returned.
- completion-decision.ts (147 lines), createCompletionDecision, returns
  applyCompletionDecision. It preserves unchanged/fork/scheduled/rework predicates,
  validation-disabled behavior and mandatory validation for changed sandbox proof.
  No-change completion cleans resources before transition/event/dependents. Other
  paths mark validating/validated or invoke the supplied validation callback.

These532 source lines are already domain-owned. They accept narrow structural
ports and import neither public PodManager nor its dependency bag. Current factory
inputs in manager pass exact shared worktree/credential/transition/preservation and
callback references. They make no service calls during construction. This research
records that wiring; it does not propose reimplementing these existing owners.

## Shared checks, transitions and events

assertExecutionTerminationVerified (:1265–1268) first checks deletion ownership,
then the existing task execution termination guard. assertGuidanceCollected
(:1270–1277) throws UNCOLLECTED_HUMAN_GUIDANCE when the real nudge queue has pending
work. ownsLifecycle (:2192–2198) checks generation and optionally container identity.
Their captured dependencies are podRepo/nudgeRepo and existing imported guards.

transition (:4034–4066) validates before mutation. It preserves the explicit extra-
update merge order, clears a compromised-worktree warning only under the original
complete predicate, records unreported memory on terminal status and updates the pod.
Completion journal marking follows update (finished/finalizing). Status change event
publication is scheduled through afterCommit where available; readiness refresh
occurs for validated/review_required/failed, then the current pod is returned.
Its callbacks remain the original recordNotReportedMemoryUsage and refreshReadiness;
readiness implementation belongs to26. This is shared by completion, execution,
validation, approval, controls and resource/recovery paths.

emitPodCompletedEvent (:4068–4086) publishes the original complete summary, including
original duration and default filesChanged expression. emitActivityStatus/Error
(:3501–3527) publish activity before calling the shared Slice24 liveness throttle.
These are shared reporting helpers; the throttle/map itself now belongs to agent-
activity.ts. formatElapsedDuration (:3514–3516) retains one-decimal seconds formatting.

## Existing operator/security diagnostic policy

summarizeAgentCompletionBlocker (:261–273) recognizes the original three environment
blocker text patterns. The new consumer receives it through an explicit callback,
so no execution owner imports manager. SECURITY_SCAN_FINDING_LOG_LIMIT (:504) is20.
The scan emitter (:3529–3556) reports the original finding count and capped set,
sanitizes rule/file/location data, and reports omitted findings. It uses the same
activity error emitter with fatal=false. Sanitization (:3558–3565) normalizes spaces,
bounds input to400 characters and calls the shared processContent preset.

The original OperatorFailurePhase (:3567) union is setup/agent/completion. Failure
sanitization bounds raw messages to1,200 characters before the existing sanitizer.
operatorErrorMessage selects the phase prefix; describeSyncFailure preserves original
Error name/message fallback behavior (:3569–3593). Slice24 contracts currently copy
the same phase union for moved callback typing while the original alias stays here;
that compatibility scaffold does not change the known original validation-phase
supplemental type diagnostic. There is no runtime dependency named after the alias.

## Existing evidence and remaining roadmap

The public manager test file remains byte-frozen at1,192 cases. Existing completion-
human-gate/source/decision suites exercise their domain contracts. All are included
in the inherited affected set. Current agent-process tests also use overridden
completion/validation commands and actual failed-startup file-reopen settlement.

Milestone25 does not absorb approval/readiness26, delivery/merge27, fixes28,
controls29, resource ownership30, recovery/workspace31 or admission32. In particular,
inline validation trigger/revalidation delivery and its temporary size exception stay
assigned27. The final <=1,500-line facade,327-item/73-member reconciliation and full
mutable-owner cleanup proof remain33/34. No whole-goal completion is claimed.

## Exact current inventory

| Function | Current manager lines |
|---|---|
| `summarizeAgentCompletionBlocker` | 261–273 |
| `assertExecutionTerminationVerified` | 1265–1268 |
| `assertGuidanceCollected` | 1270–1277 |
| `ownsLifecycle` | 2192–2198 |
| `emitActivityStatus` | 3501–3512 |
| `formatElapsedDuration` | 3514–3516 |
| `emitActivityError` | 3518–3527 |
| `emitBlockingSecurityScanFindings` | 3529–3556 |
| `sanitizeSecurityScanLogValue` | 3558–3565 |
| `sanitizeFailureReason` | 3569–3576 |
| `operatorErrorMessage` | 3578–3586 |
| `describeSyncFailure` | 3588–3593 |
| `transition` | 4034–4066 |
| `emitPodCompletedEvent` | 4068–4086 |
| `handleCompletion` | 4962–5009 |

The saved AST inventory distinguishes imports, original captures, live reads and
receiver members, including shorthand-property values. The next plan must account
for hoisted helper initialization and current shared factory composition order; this
artifact only records the current arrangement.

## Related artifacts

- ../plans/2026-10-18-pod-manager-remaining-roadmap.md
- 2026-10-19-pod-manager-agent-execution.md
- ../plans/2026-10-19-pod-manager-agent-execution.md

## Open questions

None about the current-state responsibility. Next action: author the concrete complete milestone25 plan under standing
continuation authority. Slice24 qualification is complete.

## Follow-up: construction order facts

At this baseline initial infrastructure destructuring ends at :1166. Readiness service
construction is :1519 and its refreshReadiness function is :1530. Active run/state
maps and original resource maps are constructed before activity state :2259. The
activity owner supplies recordNotReportedMemoryUsage and bumpActivityTimestamp.
Validation control construction (:2844 onward) captures termination/status/transition
functions before their current hoisted declaration text. Existing completion factories
are :3358–3399; artifact finalizer construction is :3842. New process/consumer factories
are composed near :4320–4418, before the public object. These references explain why
moving a hoisted helper to an uninitialized later const would change behavior.

The current transition body references refreshReadiness and recordNotReportedMemoryUsage;
its existing readiness/agent-activity inputs are initialized before validation control
construction. The original helper declaration positions are not equivalent to their
first required construction-time callback availability. This is a source-order fact
the next plan must preserve, alongside exact callback receiver/arity and map identity.

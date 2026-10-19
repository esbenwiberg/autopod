---
date: 2026-10-19T00:29:38+02:00
researcher: Codex
git_commit: 76ae75e1a269b074f4eb1fa5fae69d523b6890e8
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 26: complete approval, readiness, waivers and snapshots"
tags: [research, codebase, pod-manager, approval, readiness]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice 26 research: approval and readiness

## Research question and baseline

Locate the entire milestone26 responsibility after completion/transition extraction:
approveSession, readiness computation/wait/approval helpers, approval snapshots,
validation/fact waivers, forced and bulk approval. Current manager source is8,591
lines at the pushed implementation above. Slice25 full frozen qualification subsequently passed (see its plan/proof); no Slice26 product code is changed.

The canonical roadmap assigns17 function bodies (12 helpers/five public methods),
the snapshot exclusion array, readinessService construction and three type declarations
to26. The two public option/result interfaces currently remain in manager. All paths
below use packages/daemon/src/pods/pod-manager.ts at this source baseline unless noted.
Saved complete function snapshots/state construction/captured/live/receiver inventory
are in .autopod-data/approval-readiness/.

## Readiness service and helper behavior

readinessService is constructed at:1500–1509 through existing readiness-review.ts.
Its inputs are original pod/validation/scan/escalation/quality repositories plus the
then-current deps.actionAuditRepo, deps.eventRepo and deps.providerAttemptRepo.
Those three are captured construction-time arguments, not invocation-time live reads.
Existing readiness-review.ts remains a separate domain service; no rewriting is
implied by its construction still living in the manager.

refreshReadiness (:1511–1539) refreshes validated/review_required/failed pods, plus
post-decision statuses when advisoryQaInFlight is explicitly false. It returns true
for an excluded status and catches/logs refresh errors as false. The public
refreshReadinessAfterQualityScore (:7479–7481) passes advisoryQaInFlight=false.
Completion transition, validation and advisory owners receive this shared callback.

resolveApprovalReadiness (:1549–1581) checks uncollected guidance first, reads the
same advisoryRuns map and computes current review with its in-flight flag. A requested
wait emits status and awaits the existing promise, then refreshes with in-flight=false.
For a single-PR series pod with a PR and series id it uses the series review status/
summary/scope while retaining the pod review. Other pods use pod scope. The map's
allocation/other advisory resource ownership remains assigned30.

ApprovalReadiness (:1541–1547) is the local result type. normalizeApprovalReason,
readinessSkipReason and assertApprovalAllowed (:1583–1611) trim the optional reason,
reject automated non-ready approval, and require a reason for risky/waived review.
persistReadinessApproval (:1613–1648) records the original actor, time, status, scope,
optional series and reason inside the pod review, then emits readiness_approved only
for non-ready review. Approval option/result interfaces are:764–775.

## Current approval lifetime

approveSession (:5279–6072) is794 lines and has no dynamic this member or live deps
read. It captures infrastructure, callbacks and original shared maps/queue. Actor
selection and status validation precede readiness wait and reason policy. The original
approval identity is retained through every asynchronous wait and event callback.
assertApprovalCurrent (:3639–3670) checks deletion/task termination first, then the
full generation/status/agent mode/output/branch/base/target/worktree/container identity,
then guidance and unanswered decisions. Its two explicit allowances permit confirmed
removed-container or complete status at cleanup points.

Output branch/PR requires worktree/branch identity. Missing identity parks a failure
reason and throws while retaining resources. Sandbox branch/PR approval collects a
private artifact snapshot with APPROVAL_SNAPSHOT_EXCLUDES (:306–317), original
lifecycle/cycle and ownership callback before publication/cleanup. Preservation failure
retains resources and rethrows the original error after reporting.

The method reconciles existing merge journal evidence before new publication. It
preserves external disposition, merge method/provider and retained-source checks.
Noninteractive no-PR source gets fresh diff stats. When no new changes exist, it
checks accumulated branch changes; uncertain branch emptiness preserves a push.
Publication uses the original durable source ledger helpers, retains force-with-lease
allowances and fences before clearing them. Approval/readiness persistence, merging,
cleanup, complete status, completed event and dependents occur in the original order,
with identity anchors rechecked around each stage.

Normal delivery transitions through approved/merging, then uses its original fenced
operation wrapper. Existing PR delivery serializes push/rebase/merge by repository/
base mergeQueue. Review/status uncertainty cannot authorize merge. Outcomes are
merged, merge_pending (start polling) or a validated failure with retained source.
The no-PR PR-output path publishes source, creates PR, records merge planning and
checks review before merge. Other worktree output falls back to a branch push.
Cleanup and final complete/event/dependent effects happen only after confirmed
original delivery predicates. The body currently contains these inline delivery
algorithms as part of approval lifetime; the roadmap separately assigns complete
delivery/merge ownership to27, including inline validation trigger/revalidation paths.

## Other approval entry points and original policy

approveAllValidated (:7628–7650) enumerates validated pods, waits for readiness and
skips non-ready pods with original status/reason records. Each accepted pod calls
this.approveSession(id, {automation:true}). Individual errors are logged; the method
returns its approved/skipped lists. This is a dynamic invocation-receiver call.

approveFactWaiver (:7676–7750) permits running/validating/failed/review_required pods.
Settled safe pods with no guidance or unverified task termination may immediately
revalidate; active/unsafe runs only record a decision for next validation. Latest fact
or reverse historical validation lookup supplies authority. Only pending_human or
already-waived facts can be approved. The helper merges one approved_waive decision
without discarding other facts/deviations. Immediate revalidation calls the dynamic
this.revalidateSession(id, {force:true}); other paths return the original fail result.

forceApprove (:7752–7805) accepts failed/review_required/awaiting_input. It records the
original note and optional validation waiver, resolves a pending escalation with actor/
audit response, transitions to validated, emits activity and triggers dependents.
It does not execute normal delivery itself and contains no this call.

actorLabel/legacyRespondedBy/buildValidationWaiver (:268–292) retain actor identity,
legacy audit classification, failed phase/fact lists and original waiver defaults.
parseValidationOverrideResponse (:521–568) creates dismiss-all, selected one-based
indices or guidance decisions with shared timestamp; it remains an internal helper
used by other control paths. taskSummaryWithApprovedFactWaiver (:3500–3529) preserves
existing summary/deviations and chooses original approval reason/why-impossible values.

## Construction-order facts

The readiness service is created before the shared advisoryRuns map and agent-activity
state. refreshReadiness is currently hoisted; the new completion-events factory at
:2235 onward captures it. resolveApprovalReadiness also uses emitActivityStatus, which
is supplied by that completion-events factory. Thus service/refresh availability and
advisory wait/status-helper availability occur at different source construction points.
The next plan must preserve these existing dependency relationships; replacing all
helpers with a single late const would change constructor behavior.

Existing approval methods use the shared forceWithLeaseAllowances set, mergeQueue,
advisoryRuns map and cleanup/polling callbacks. Resource construction remains assigned
later milestones; these references are original instances, not newly allocated state.
The original794-line approval body is the largest26 item; this records its full scope,
not a claim that moving only policy helpers completes the milestone.

## Existing tests and historical scope

The full public manager test file remains frozen at1,192 cases, including approval
reconciliation, stale callbacks, source retention, force/bulk/fact waiver/readiness
and advisory waiting. Source/merge ledgers, task execution, actual SQLite and controlled
provider/worktree/container infrastructure back those tests. Existing readiness-review,
artifact snapshot and durable merge/publication suites cover the collaborator contracts.
No paid provider/live Docker/Azure acceptance is inferred from this local coverage.

Slice25 is now fully qualified; the remaining goal is the complete26–34 roadmap. Final<=1,500-line facade and327-unit/73-member/mutable-owner reconciliation
remain33/34. Readiness, approval and delivery changes must preserve original policy;
this research does not recommend new behavior or declare the goal complete.

## Exact function inventory

| Symbol | Current manager lines |
|---|---|
| `actorLabel` | 268–272 |
| `legacyRespondedBy` | 274–276 |
| `buildValidationWaiver` | 278–292 |
| `parseValidationOverrideResponse` | 521–568 |
| `refreshReadiness` | 1511–1539 |
| `resolveApprovalReadiness` | 1549–1581 |
| `normalizeApprovalReason` | 1583–1586 |
| `readinessSkipReason` | 1588–1592 |
| `assertApprovalAllowed` | 1594–1611 |
| `persistReadinessApproval` | 1613–1648 |
| `taskSummaryWithApprovedFactWaiver` | 3500–3529 |
| `assertApprovalCurrent` | 3639–3670 |
| `approveSession` | 5279–6072 |
| `approveAllValidated` | 7628–7650 |
| `approveFactWaiver` | 7676–7750 |
| `forceApprove` | 7752–7805 |
| `refreshReadinessAfterQualityScore` | 7479–7481 |

Two construction snapshots retain the exact snapshot array expression and readiness
service arguments. The inventory distinguishes actual imports, captures, live property
reads and dynamic receiver calls, including shorthand-property symbols.

## Related artifacts

- ../plans/2026-10-18-pod-manager-remaining-roadmap.md
- 2026-10-19-pod-manager-completion-orchestration.md
- ../plans/2026-10-19-pod-manager-completion-orchestration.md

## Open questions

None about current behavior. Next action: author the concrete complete26 plan under standing continuation authority, with construction
order and full approval lifetime in scope.

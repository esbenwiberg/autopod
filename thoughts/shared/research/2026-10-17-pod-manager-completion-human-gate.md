---
date: 2026-10-17
repository: autopod
branch: codex/pod-manager-workspace
commit: 52e19de13907deec1737fb56829f833a5fcb2678
topic: Completion handling for unanswered decisions and uncollected guidance
status: complete
---

# Completion human gate: current behavior

## Research question

What currently stops a settled worker from completing while human work remains,
and how does that connect to workspace preservation, the journal and guidance?

## Summary

At baseline 52e19de1, handleCompletion contains two early-return branches before
artifact/source output dispatch. An unanswered question retains its pending state.
Uncollected guidance preserves source where possible and parks the owning running
pod as failed for explicit Rework. Neither branch consumes guidance or answers a
question. The three preceding slices extracted workspace preservation, transfer
and validation preparation; pod-manager.ts remains 18,040 lines.

## Source map

References are relative to packages/daemon/src/ at the recorded baseline.

- pods/pod-manager.ts:11079: handleCompletion reads the pod, checks native Goal
  achievement/termination, and returns for terminal or already-progressed states.
- pods/pod-manager.ts:11106: awaiting_input or pendingEscalation takes precedence
  over guidance. Journal settlement is optional. Existing sourcePreservedAt skips
  capture; containerId and worktreePath are both required for capture. Successful
  preservation is followed by mark(awaiting_human, true). Preservation and mark
  errors are logged; activity is emitted and completion returns. Settlement and
  activity errors are outside this catch. There is no post-await ownership check.
- pods/pod-manager.ts:11128: nudgeRepo.hasPending triggers settlement followed by
  optional capture. Capture failure contributes exact text to the eventual reason.
  ownsArtifactCompletion(pod, false, true) is checked after capture. If it fails,
  completion returns without the following mark/failed transition/activity.
  Otherwise the current pod is reloaded, journal mark and failed transition run in
  atomicPodChange, then activity is emitted. Existing sourcePreservedAt does not
  suppress capture on this branch. The queue stays pending.
- pods/pod-manager.ts:11161 onward: artifact dispatch and artifactCompletionRuns
  coalescing precede source synchronization and validation/delivery decisions.
- pods/pod-manager.ts:6075: ownsArtifactCompletion checks generation, container,
  running status, no pending escalation and (unless allowed) no queued guidance.
  It is shared with other completion code; the guidance branch allows the queue.
- pods/pod-manager.ts:6365: transition validates the status change, updates through
  podRepo.update, schedules status publication through afterCommit when available,
  refreshes readiness for failed and returns the current pod. It remains shared.
- pods/pod-manager.ts:5466: extracted workspace factories are composed together.
- pods/artifact-finalizer.ts: existing typed factory pattern with narrow repository
  dependencies and a manager-owned transition callback.

## Persistence and delivery

pods/completion-journal.ts keeps settlement and source proof by lifecycle/cycle.
Repeated settlement retains the first timestamp. mark does not erase an existing
source timestamp when called with false. A question remains durable until the
reply path records it; gate handling does not call recordReply.

pods/nudge-repository.ts: hasPending checks consumed=0; listing does not consume.
pods/operator-guidance-delivery.ts: read returns a durable delivery receipt for the
active worker. Acknowledgment, with ownership checks, is the consumption boundary.
A recorded human answer or a read without acknowledgment can still leave guidance.

pods/pod-repository.ts exposes optional completionJournal and optional UnitOfWork
methods for injected legacy repositories. Production supplies both. The gate uses
optional property access at operation time rather than capturing the journal once.

db/unit-of-work.ts: atomicPodChange calls the repository transaction when present,
otherwise executes the callback directly. Production rollback discards queued
post-commit effects. Settlement precedes the guidance transaction and is therefore
outside that rollback. Workspace capture is also outside the transaction. This is
not a transaction over resources, journal settlement and all completion actions.

## Existing evidence

- pods/pod-manager.test.ts has real SQLite context and injectable infrastructure,
  public handleCompletion, deferred promises, observable event/status/validation
  boundaries, and prior-slice compatibility groups.
- e2e.test.ts covers collected replies, unread replies, read-without-ack replies and
  storage failure around a real guidance queue.
- pods/pod-lifecycle.e2e.test.ts covers detached MCP replies and worker completion.
- pods/attached-reply-delivery.test.ts exercises ask_human/report_blocker through
  actual in-memory MCP transports, dropped delivery, storage rollback, durable
  response identity, receipt acknowledgment and completion admission.
- pods/operator-guidance-delivery.test.ts covers receipt replay across disk reopen,
  ownership changes, batch membership and transactional acknowledgment failure.
- pods/completion-journal.test.ts covers actual close/reopen, unanswered decisions,
  source proof, duplicate settlement, stale lifecycle and schema upgrade behavior.
- db/unit-of-work.test.ts covers nested commit publication and rolled-back effects.
- Prior slice suites cover physical workspace transfer and preservation behavior.

No product source or tests were changed, and no tests were run for this research.
No unresolved factual blocker remains. The companion plan selects a bounded move.

---
date: 2026-10-15
researcher: Codex
git_commit: 32128483eef0c485c2212d481409492f4a23bcfb
branch: codex/reliability
status: complete
---

# Existing reply acceptance boundary

Research only; no API expansion, receipt endpoint, persistence or automatic replay
is implemented or authorized by this artifact. research_lifecycle traced routes,
admission, receipts and tests; root read the entire sendMessage method and the
coordinator, unit-of-work and completion-journal modules plus route/schema entry.
The whole large pod-manager module has not been read for a restructuring plan.

sendMessageSchema (shared/src/schemas/pod.schema.ts:284) accepts only message.
The HTTP route (daemon/src/api/routes/pods.ts:849) awaits manager.sendMessage and
returns ok:true. No expected decision ID or request key reaches the manager.
Normal admission checks pause settling, Goal restrictions and message eligibility.
Its synchronous persistCompletionReply call (pod-manager.ts:13007) atomically
records the decision receipt, changes status/clears the pending question, and
optionally queues delivery for a retained worker. No normal-path await precedes
this boundary. escalation-coordinator.ts:85 delegates that atomic unit to the
repository; unit-of-work.ts publishes effects after database commit.

CompletionJournal.recordReply keys receipts by pod/decision ID and preserves the
first actor/time for identical answers, rejects a conflicting answer and stale
lifecycle generation, and updates escalation/finalization records. With no pending
escalation it records nothing. This is receipt-write idempotency, not idempotent
message submission: a duplicate return does not stop the outer transition or
continuation, and the client does not name the decision it intended to answer.

After normal acceptance, attached waiter delivery or an existing retained run may
return immediately. Otherwise environment/auth, preflight, sandbox resume, runtime
consumption, credential persistence and completion can still fail and cause the
HTTP request to fail despite the recorded answer. Post-commit event publication
can also fail without undoing the receipt. A repeat after a later question appears
has no client identity binding to distinguish that new decision.

Special branches differ:

| Branch | Current acceptance boundary |
|---|---|
| Budget pause | Extension count/pause reason/status updated before completion await; no decision receipt |
| Host-fetch credential repair | Await credential resolution, update escalation, clear and requeue; no completion receipt |
| Host-push credential repair | Await credential resolution, update escalation/status, then await push/PR work; no completion receipt |
| Other credential request | Atomic completion receipt plus saved daemon-delivery guidance and waiter resolution |
| Validation override | Can await Goal rework first; escalation, overrides and transition use separate updates; then validation/continuation |
| Paused/resume without escalation | Normal branch with no decision receipt; input goes to retained queue or resumed runtime |

Current detail/finalization responses expose state, not acceptance of a particular
submitted answer. GET events returns activity/firewall replay, not completion
receipts. No receipt-by-decision read method or HTTP endpoint exists. History
escalation export is not a completion-decision reconciliation contract.

Existing tests inspected by the research worker, not newly executed: manager
preflight failure after durable answer and transition rollback; attached reply
delivery/response loss/reopening; completion-journal duplicate/conflict/generation;
retained-run queue rollback and delivery; settling pause and budget extension.
The lifecycle test named pauses/resumes does not actually invoke those operations;
its title alone is not boundary proof.

This establishes a distinction between recorded answer and successful continuation.
It does not prove safe client resubmission, acceptance reconciliation, or a uniform
transaction across special branches. Those require a separately bounded plan.

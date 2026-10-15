# R04d: inline in-flight Pause and Kill

## Scope and authorization

Implement the first bounded native slice of the user-selected Inline wireframe:
show an in-flight Pause/Kill separately from confirmed pod status and suppress
simultaneous duplicate commands. User selected Inline and authorized autonomous
RPI, workers, review and branch integration. Research is
`../research/2026-10-15-desktop-interaction-ownership.md`; visual direction is
`2026-10-15-desktop-state-wireframes.html`. No new product capability or navigation.
Root owns this plan. Implement all phases after independent technical review.

This slice owns a single ActionHandler lifetime. Reconnect-persistent unknown
outcomes, drafts, Resume/reply, connection identity and other actions remain
subsequent bounded tasks. Do not display reconnect/outcome-reconciliation promises
before those behaviors exist. Existing failed-request alerts remain authoritative
for reporting errors; a failure never changes the confirmed lifecycle status.

## Current behavior

R04a removed optimistic Pause/Kill status writes. Both methods still send every
call, expose only a single handler-wide pendingAction string and await a best-effort
refresh that swallows errors. No production view consumes that pending marker.
Detail, cards and the enabled series activity panel receive PodActions; its getter
closures already expose other handler state. MainView copies the whole struct.
Card Kill-and-delete awaits a Void kill that catches errors, then always deletes.
A duplicate guard must not return early and accidentally advance that sequence.

## Phase1: request ownership and completion

Own ActionHandler.swift and narrowly extended PodActions.swift. Add a small
Sendable/Equatable UI presentation enum for Pause/Kill/combined Kill-and-delete
pending kind and a
MainActor Sendable `pendingControl(podId)` getter with a nil preview default.
No MainView plumbing is needed. Keep API wire methods and existing pause/kill
closure signatures unchanged.

ActionHandler owns a per-pod operation record: UUID identity, control kind and
Task<Bool,Never>. Store observable presentation state separately from task handles
if needed for Observation/Sendable compatibility. Set the record before the first
suspension. Same-pod/same-kind calls join the existing task; they must not POST,
GET, publish duplicate errors, or finish before the original operation. A different
kind for an already-busy pod returns false internally and sends nothing; the
normal UI disables both controls while one is busy. Different pods proceed
independently. Cleanup removes only its own record; one pod's completion cannot
clear another pod's pending presentation.

The owned task performs exactly one existing POST and, only on success, the
existing best-effort refresh. It returns true only for an acknowledged successful
POST, false on POST failure. This result means request acknowledgement, not observed
state, successful refresh or a causally proven lifecycle outcome. Existing error
reporting and confirmed-state merge behavior stay intact. Legacy pendingAction may
remain for compatibility but must only be cleared if still owned by that operation;
new UI correctness never depends on that single string. Joining caller cancellation
does not cancel a task shared with another caller. Owned URLSession cleanup in tests
must still release all tasks. No retry or delayed second command is scheduled.

Add `killAndDelete` to PodActions with a no-op preview default and wire a handler
method for the existing card workflow. It joins/executes Kill through the same
owned operation and calls the existing delete method only after true acknowledgement.
False/conflicting/failing Kill never sends DELETE. Successful POST plus failed GET
retains existing server-authoritative deletion eligibility; do not infer a killed
snapshot. The daemon still authorizes deletion. Card uses this combined closure
when it already offers Kill-and-delete, and plain delete when already deletable.
Coalesce duplicate killAndDelete workflows themselves through their complete
Kill-then-Delete lifetime: joining Kill alone would otherwise let two callers send
two DELETEs. This separate owned workflow must not recursively await itself.
Expose the combined pending kind from admission through DELETE completion, including
the gap between its Kill and Delete awaits. Its notice is `Kill and delete requested
— waiting for daemon`; it remains accurate during both operations. An overlapping
public plain-delete call must join the combined workflow instead of sending a
second DELETE. The combined task uses a private raw-delete path to avoid self-join.
Do not permit a new Pause/Kill to slip into a combined workflow after Kill finishes.
Keep ownership identity checks on both registries and do not broaden other actions.
No confirmation text or delete eligibility redesign.

Establish baseline duplicate-POST and unconditional-delete behavior before the
production repair using the existing held private URLSession transport. Keep
baseline tests runnable against old interfaces; add presentation/new combined-path
assertions after those interfaces exist. No guessed baseline claims.

## Phase2: native Inline presentation

Own DetailPanelView.swift, PodCardFinal.swift and PodActivityPanel.swift plus one
small reusable UI notice if it avoids divergent text. Use existing styles and
spacing. At the pod heading show `Pause requested — waiting for daemon` or
`Kill requested — waiting for daemon` while the owned operation exists; use the
combined workflow wording above when applicable. Buttons
show `Pausing…`/`Killing…` for the active kind, and disable both Pause and Kill for
that pod while busy. Confirmed status badge, work/evidence, selection and other
pod controls retain their current source of truth. Never replace Running with
Paused or Killed because a request is pending or its POST returned200.

Cover detail's wide/wrapped headers, compact/expanded cards, card context Kill,
Kill-and-delete confirmation and the enabled series panel Pause. Prevent a card
Delete from racing its active control by disabling that affordance while busy;
the combined handler still protects programmatic duplicate callers. Do not disable
an entire detail page or unrelated pod. Remove the notice when the operation ends;
existing error presentation handles failed requests. No `confirmed`, `reconnecting`,
`outcome checked` or freshness age wording is added by this slice.

## Phase3: deterministic and rendered proof

Use the extracted held REST transport after R04c integration. Tests exercise actual
DaemonAPI/ActionHandler/PodStore and wired PodActions with private sessions, bounded
barriers and complete cleanup. Required cases:
- Same Pause and same Kill invoked twice: one POST, one refresh on success, both
  callers await completion; on POST failure no GET, one error and retained state.
- Hold successful POST's GET: pending remains and confirmed state is unchanged.
  Failed refresh removes only pending; it does not invent status or success text.
- Different pods pending together; complete one and keep the other pending.
- Pause vs Kill conflict on one pod sends only the first command; no queued replay.
- Kill-and-delete failure or conflicting Pause never DELETEs; duplicate Kill joins
  and DELETE starts only after acknowledged Kill and its awaited refresh finish.
  Two combined-workflow callers produce one DELETE and both await a held DELETE;
that held DELETE must not be reported as completed. After the Kill refresh changes
status to deletable, the actual card Delete must remain disabled until the combined
workflow settles; overlapping plain-delete entry joins it without another request.
Existing deletion errors remain.
- Cancel initiating and joining callers separately while the shared POST/GET is
held; remaining caller still awaits one request sequence and pending stays owned.
Repeat during a combined workflow held at DELETE. Disposal releases all tasks.
- Existing20 confirmed-action invocations continue passing, including newer events.
- Getter preview defaults and actual MainView action-copy path stay compatible.

Render actual production detail/cards/series composition in NSHostingView using
actual wired handler/store. Keep the same mounted view across initial -> held POST
-> held GET -> completion/failure transitions; no remount or replacing a fake
pending prop to conceal missing Observation updates. Verify real getter-driven
notice updates and disabled controls via available native accessibility/layout
inspection, with bounded wait for an observable render condition. Capture and
inspect pending Pause and Kill, retained Running, confirmed updated state and
failure for detail at900 and600px and cards at their supported compact/expanded
widths; cover series panel Pause in its real composition. Exact widths/paths go
in evidence. Do not claim button activation unless actually exercised; handler-
invoked composition is distinct from integrated app interaction. No personal
preferences, Keychain, notification prompts or live account bootstrap.

Run focused new and existing action/store tests, full Swift suite, desktop executable
build, secret/diff checks. Worker captures actual screenshots and evidence, then
freezes head. Independent reviewer inspects source, reruns request/duplicate proof
and selected actual native captures, and views every material screenshot before
PR into codex/reliability. Hosted native/general checks then integrated focused
proof. Screenshots are automated evidence, not human signoff. No human preference
question is required because this uses the selected Inline direction.

## Acceptance

- [ ] Baseline duplicate/control-delete hazards reproduced.
- [ ] Per-pod ownership joins duplicates, keeps other pods independent and gates delete.
- [ ] Inline notice/disabled controls observe real pending state with confirmed status intact.
- [ ] Required narrow/wide and card/series native captures inspected.
- [ ] Independent pre-PR, hosted and integrated proof recorded.

## Compatibility and rollback

No persistent schema, API wire, dependency, new feature or navigation change.
PodActions existing pause/kill signatures and preview behavior remain compatible;
combined deletion closure replaces an existing client sequence. Revert presentation
and owned-operation helper to restore prior behavior. This task does not solve
same-pod operations across handler replacement, app restart, ambiguous response
reconciliation, draft retention or full-app bootstrap isolation. Those claims must
remain absent from release notes until separately proved.

## Status

Independent research_cli plan review identified combined-workflow busy ownership
through DELETE and missing explicit caller-cancellation proof. Root incorporated
both: combined notice/disable lifetime, plain-delete join without self-recursion,
and initiating/joining cancellation cases. Resolved under standing authorization;
ready for worker dispatch after R04c shared held transport is integrated. No
unresolved product decisions.

## Phase 0: validation prerequisite (root authorized)

Expected: a clean Swift baseline executes the duplicate/delete reproductions.
Found: fresh Swift 6.3.3 compilation repeatedly rejects the unchanged resync
URLProtocol Task's implicit capture; hosted Swift 6.1.2 had passed.
Why it matters: the test target cannot compile, blocking executable baseline proof.
Adjustment: match the existing DaemonAPITests request snapshot plus explicit
Sendable captures in EventStreamResyncTests only. Commit this prerequisite
separately; compile and run resync + old-interface inline baseline before any
product changes. Failed logs are preserved under `.autopod-data/reliability/r04d/`.

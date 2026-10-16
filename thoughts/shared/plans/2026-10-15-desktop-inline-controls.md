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

- [x] Baseline duplicate/control-delete hazards reproduced.
- [x] Per-pod ownership joins duplicates, keeps other pods independent and gates delete.
- [x] Inline notice/disabled controls observe real pending state with confirmed status intact.
- [x] Required narrow/wide and card/series native captures inspected.
- [x] Independent pre-PR, hosted and integrated proof recorded.

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


## Execution clarification: detail Delete controls

Root review found that a combined workflow can still own a held DELETE after its
Kill refresh makes the pod deletable; a newer killed event can likewise arrive
while a plain Pause is held. Card Delete was disabled but the equivalent detail
Delete controls were still enabled. Root authorized extending the same pending
presentation guard and identifiers to the three detail Delete buttons and their
confirmation. Handler semantics and unrelated controls remain unchanged.
Before the extension, native same-mounted tests at 900 and 600 pixels reproduced
four enabled-Delete failures across those two scenarios; see ignored evidence
`r04d/detail-delete-before-fix.log`. This is a bounded phase 2 consistency repair.


## Worker execution and proof (2026-10-15)

All authorized implementation phases are complete at code/test revision
`2a8f546559d5637549744eb63ab71dcaec554a05`; the following evidence update is
prose only. Root retains independent review, PR, hosted checks and integration.
No human visual signoff is claimed.

Phase 0 prerequisite `653f7db5` compiled and ran the unchanged resync test and
runnable old-interface baseline at `8d7ca645`: repeated Pause/Kill emitted two
POSTs and the previous Void Kill-then-Delete path issued DELETE after rejected
Kill. Three functions/four invocations passed their baseline assertions. The
baseline source is preserved in that commit and ignored evidence, removed from
the final target. Failed space/fresh-compiler logs are retained; only the approved
test capture adjustment was made.

Phases 1–2 use per-pod owned tasks, independent observable presentation, shared
acknowledgement gating and full combined-workflow lifetime. Existing async Void
Pause/Kill closures and confirmed-state refresh behavior are preserved. Native
controls consume the real getter. Root's additional detail Delete consistency
repair was reproduced before its presentation-only fix (four failures at both
widths). No other action or persistent state was changed.

Phase 3 verification on frozen final code:
- Node 22 / pnpm 9.15.4 frozen installation passed (`install-rerun.log`).
- `swift test --package-path packages/desktop --no-parallel --filter
  'InlineControlRenderingTests|inlineControl|inlineCombined|confirmedAction|confirmedKill|PodStore'`
  passed 31 reported tests in 3 suites (`focused-final.log`). This includes the
  existing 20 confirmed-action invocations, one-error-publication observation,
  independent pods, conflicts, initiating/joining cancellation, combined/plain
  joining through held DELETE and actual native action entry points.
- `AUTOPOD_INLINE_RENDER_DIR="$PWD/.autopod-data/reliability/r04d/final-captures"
  swift test --package-path packages/desktop --no-parallel` passed 434 Swift Testing tests in 17 suites plus 13 XCTest tests
  (`full-swift.log`). The existing opt-in `LiveVillageConnectionTests` suite and
  `configuredDaemonReachesStoresEventsAndBundledVillage()` test were skipped
  (log lines 441–442); no live-daemon validation is claimed.
- `swift build --package-path packages/desktop --product AutopodDesktopExe`
  passed (`build.log`). Node 22 `node scripts/secret-scan.mjs` and `git diff --check`
  passed (`secrets.log`).

Ignored evidence lives at `.autopod-data/reliability/r04d/`; `proof.json` contains
claim verdicts, commands, source hashes and SHA256/dimensions for all 47 final
PNGs. The worker opened and inspected all 47. Final images/AX sidecars are in
`final-captures/`; earlier `captures/` images are preliminary and superseded.
Detail captures are 900×760 and 600×760. Card content is 260px wide inside a
276×180 compact or 276×320 detailed host. Series is 900×760. MainView's native
host measured 1400×832 from a requested 1400×800; cause was not established.
Its test asserts width and visible-notice bounds and records actual dimensions.
The failed fixed-height run is retained in `full-before-main-bounds-adjustment.log`.

The native hierarchy remains mounted through initial, held POST, held GET and
completion/rejection. The host never reads the pending getter; production views
must observe it. Native AX checks prove visible notices and disabled controls,
and native menu/confirmation, series node/Pause and MainView Pause activations
are followed by actual held transport requests. Fixture cleanup closes sheets,
windows, private defaults suites and URLSession requests, and waits for handler
ownership to clear. No personal preferences, Keychain or account bootstrap runs.

Proof verdict: **PROVEN for the bounded ownership and changed inline components**.
The captures show pending notices separately from retained Running/Killed states,
cleared notices after response and disabled Delete throughout combined deletion.
Limitations are explicit: test transactions disable animations; no animation
or full-app visual fidelity claim. Native bitmap capture leaves compositor
artifacts in the unchanged MainView sidebar/toolbar, series picker and confirmation
Cancel button. These images establish the affected detail/panel content; dialog
activation is established by the native request test, not full dialog pixels.
An owned-window screencapture attempt returned `could not create image from window`;
no OS permission changes were requested. Initial series snapshots raced animation
and are superseded by the settled final captures. Synthetic private transport
qualifies client ownership, not a live daemon lifecycle. Reconnect-persistent
unknown outcomes/drafts and full startup remain outside this slice.

## Coordinator closure

Root independently reviewed final source and the corrected proof at4e91054c.
All31 focused native functions passed;47 independently regenerated PNGs were
byte-identical to the worker's47 images that root inspected (39 initial plus8
detail Delete regression captures). No unresolved actionable source findings.
The sole integration conflict was the plan append; reviewed merge30278af1 kept
the entire packages tree unchanged and passed32 functions including resync.

PR431 passed general CI38800543540 and native38800543492 (Swift tests, village
contract, Xcode app build), then merged into campaign at1ace904a. Integrated
32 functions/4 suites passed and47 regenerated images matched reviewed evidence.
The first integrated Swift invocation passed, but its shell wrapper attempted
to assign zsh's read-only status variable; the corrected wrapper rerun exited0.
Both logs remain. Evidence and hashes are in ignored r04d/root-proof.json, with
worker/final/root/integrated captures retained. Existing live opt-in suite skipped
in the worker full suite; no live/full-startup/human/compositor claim added.

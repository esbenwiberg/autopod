# R07a: command palette keyboard ownership

## Scope and authorization

Repair keyboard execution in the existing command palette when live inputs change.
User authorized autonomous RPI, workers, review and branch-contained integration.
Root owns this plan, based on command-palette-lifetime research. An inline wireframe
was shown in chat before implementation: the existing search box, highlighted
fix/recovery-b row above fix/recovery-c, and Enter opening the highlighted B row.
Layout, labels, matching rules and actions stay the same. Branch-title search is
research only and outside this task. No new command or navigation destination.

## Current behavior

CommandPalette installs an NSEvent local monitor once on appearance. The closure
captures a SwiftUI value whose non-State arrays/actions/callbacks can be replaced
in the current rendered view. Row display and keyboard selection can therefore
refer to different inputs. The local monitor also lacks a host-window check.
Existing tests exercise result filtering, not mounted keyboard event dispatch.
Native coordinator patterns elsewhere update their closures in updateNSView.

## Phase 1: establish actual boundary behavior

In an isolated native NSHostingView/NSWindow fixture, mount production CommandPalette
once with mutable inputs and callback recorders. Enter an existing matching query,
observe A/B rows, replace inputs with B/C, wait for the visible rows to update, then
deliver synthetic NSEvents through NSApplication.shared.sendEvent with the fixture
windowNumber and actual query-field focus. Prove which callback ran. Direct window
or coordinator dispatch does not establish the local-monitor boundary.
Also replace action/selection callbacks without changing result IDs/titles to
exercise owner refresh independently of result identity. Preserve pre-fix logs
and fixture source/revision. Baseline must establish actual captured-event behavior,
not merely call the new helper or a copy of its implementation.

No OS-wide keystrokes, accessibility permission changes, account startup, daemon
calls or real approve/kill actions. All actions are synthetic recorders. If the
native event-delivery boundary cannot be exercised, report the limitation before
substituting source inference as proof. A narrow injectable monitor seam can
supplement native proof, but does not replace the initial defect reproduction.

## Phase 2: latest callbacks and bounded lifetime

Own only CommandPalette.swift plus a small package-internal native keyboard bridge
in the same directory if needed. Use NSViewRepresentable/reference ownership so
updateNSView refreshes keyboard callbacks on every render update, including changes
where rows have identical IDs. Do not key updates solely on result IDs or query.
Keep the existing selection, wrapping, query reset, click and submit behavior.
Do not change SwiftUI State during body evaluation.

Associate interception with the actual hosting window. Only consume supported
keys while the palette is presented and attached, for events belonging to that
window. Other-window and unrelated key events pass through unchanged. Detachment,
dismissal and dismantling remove the monitor, with idempotent cleanup and no retained
old callback owner. Reopening installs exactly one current monitor. Use weak
capture where appropriate; preserve current key codes and no keyboard shortcut
redesign. Keep native ownership test seams internal and production-defaulted.

## Phase 3: native regression and independent proof

Add focused tests under the existing native test targets, using real mounted
production palette, bounded observable waits, private defaults, controlled windows
and callback/task cleanup. Serialize native cases to avoid shared application
focus/monitor interference. Do not depend on personal pod data or preferences.

Required cases:
- Mount A/B, render B/C without remount, Return selects displayed highlighted row.
- Result count shrinks/grows; arrows use the current list and safely handle empty
  results; Return on empty does nothing. Query changes reset selection as before.
- Replace profile rows and current callbacks/actions while IDs stay unchanged;
  keyboard invokes only current owner. Mouse and Return agree on target.
- Return/keypad Enter/Escape and arrow handling remain functional. Field onSubmit
  plus local monitor never execute twice for one event.
- A second window's supported keys pass through without executing/dismissing the
  palette. Close while retaining the window/contentView, separately from detach
  and dismantle: the old monitor cannot consume; reopen routes once.
- Assert installation/disposal counts through a narrow seam if useful, and prove
  native event forwarding/activation independently at least once.

Capture and inspect actual palette at its existing480px width before and after
live replacement, selected-row movement, empty results and successful activation
(destination callback evidence alongside pixels). Include both synthetic content
and callback owner replacement. No visual redesign or full-app startup claim.

Run focused CommandPalette/search/native ownership tests, full Swift suite,
AutopodDesktopExe build, Node22 secret scan and git diff check. Record skips and
exact revision. Freeze source and evidence; independent reviewer reads final diff,
reruns native event reproduction, inspects material captures and checks ownership
teardown before PR into codex/reliability. Hosted general/native and integrated
focused checks must pass before closure. No human signoff is inferred from captures.

## Acceptance / compatibility

- [x] Existing stale keyboard behavior reproduced through actual native delivery.
- [x] Rendered rows and current callbacks own keyboard execution.
- [x] Window scope and repeated lifecycle teardown proven.
- [x] Material native states captured and inspected (bounded palette; mouse exception below).
- [x] Independent pre-PR, hosted and integrated checks recorded.

No API, schema, dependency or persistent-state changes. Existing public palette
initializer and commands remain compatible. Revert the keyboard bridge/dispatch
change to restore prior behavior. This does not qualify full application navigation,
all keyboard accessibility, branch-title search or external-window OS behavior.
All phases are authorized together after independent technical plan review; root
resolves in-scope implementation choices under standing user authority.

Independent plan review: lifecycle reviewer found no architecture blocker. Native
sendEvent delivery, one callback per event, and close-with-retained-content proof
are explicit requirements above. Root approves all phases under standing authority.

## Execution evidence

Phase 1: on source base `21b50a2b`, the real mounted production palette rendered
A/B then B/C. With its actual NSTextField editor focused, a Return NSEvent delivered
through `NSApplication.shared.sendEvent` invoked `pod:recovery-a` once instead of
`pod:recovery-b`. The fixture asserts one mount and observes current native labels
before delivery. `swift test --package-path packages/desktop --filter
CommandPaletteKeyboardTests` failed at that behavioral assertion as intended.
Baseline fixture, unchanged production source, logs and captures are preserved in
ignored `.autopod-data/reliability/r07a/`. All callbacks are synthetic recorders.


Phase 3 proof adjustment (root authorized):
- Expected: literal native mouse activation and Return select the same updated row.
- Found: the SwiftPM helper's visible windows accept the actual query field editor
  as first responder, but do not become key windows. Synthetic mouse down/up via
  NSApplication and NSWindow, including separated run-loop turns, did not invoke
  the unchanged SwiftUI onTapGesture. Its static-text AX press returned false.
  A bounded test-process activation attempt did not change this; the previous
  process activation policy was restored, and that attempt is not in final tests.
- Why it matters: a source-level argument or AX labels cannot prove mouse activation.
- Adjustment: root explicitly permits the narrow mouse proof gap. Preserve failed
  logs and fixture under ignored r07a, do not alter product click UI, and do not
  claim mouse activation or full-app focus. Core acceptance stays real application
  sendEvent keyboard execution against updated rows/owners and window lifecycle.

Native mounted owner replacement invokes only the new recorder. SwiftUI can retain
old view values independently of the keyboard bridge, so direct bridge ownership
checks separately prove callback release on replacement/disposal; the mounted test
checks old-owner non-invocation rather than claiming whole-SwiftUI deallocation.


### Final worker verification

Source/test revision `927f39ef99ef1b05421c4334819d0cc8cd0a9f72` includes the clean
campaign merge `be22402d`. Only the palette, its internal native attachment, focused
native tests and this plan differ from that campaign base. `updateNSView` replaces
callbacks on every render. Native monitoring is scoped to the attached window;
close, visibility/update, detach and dismantle manage its lifetime. A presentation
guard also prevents a queued submit/second key from re-executing after dismissal.
The existing row click closure, layout, matching rules and public initializer are
unchanged.

- Focused command `swift test --package-path packages/desktop --filter
  'CommandPaletteKeyboardTests|commandPalette'`: 11 test functions passed (15 cases
  including arguments). These cases also passed in the final full run after the
  merge and the strengthened same-result-count query-reset assertion.
- Final `swift test --package-path packages/desktop`: 454 Swift Testing functions
  plus 13 XCTest cases passed. Existing opt-in `LiveVillageConnectionTests` and
  `configuredDaemonReachesStoresEventsAndBundledVillage` were skipped. No live
  daemon, account or provider action was exercised.
- `swift build --package-path packages/desktop --product AutopodDesktopExe`: passed.
- Node22/pnpm9.15.4 `pnpm secret-scan`: passed; `git diff --check`: passed.
- Native application sendEvent proof covers replacement A/B→B/C, same-ID callback
  replacement for pods/profiles/actions, current list size/wrapping, empty results,
  query reset without ID/count changes, Return/keypad Enter/Escape, exact single
  callback, unrelated text input, all supported keys in another window, retained
  close/reopen, detach/re-attach, dismantle and idempotent disposal. A direct bridge
  test proves replaced/disposed callback capture release.
- Fourteen PNGs were generated from the final full run and inspected (seven unique
  pixel states; matching SHA256s identify duplicate owner/activation images). The
  native host is 520×400 with the existing 480px palette. Companion text records
  contain callback targets and one-mount assertions. The fixture deliberately keeps
  content mounted after presentation becomes false to test dispatch lifetime:
  `*-activated.png` shows retained palette content; the companion callback evidence,
  not a destination screen, proves activation. There is no full-app startup/layout,
  key-window focus, literal mouse activation or real approve/kill claim.

Ignored evidence: `.autopod-data/reliability/r07a/proof.json`,
`baseline.log`, `baseline-captures/`, `baseline-fixture.swift`,
`baseline-CommandPalette.swift`, `focused.log`, `final-full-swift-verified.log`,
`build.log`, `secret-scan.log`, `final-captures/`, and retained unsuccessful native
mouse/focus probes. Scope-adjusted local proof is PROVEN; literal mouse activation
remains unproven under the explicit root adjustment. Independent pre-PR review,
hosted CI and integrated focused checks remain root-owned and unchecked above.

Final review cleanup: the retained-content test's timeout label now says "keyboard
activation" (it delivers Return). This is a diagnostic string correction only;
full-run assertions and production source remain those verified at `927f39ef`.

## Independent review and campaign closure

Root and desktop reviewer found no actionable issue at2d926e6a. Root reran12
functions/1suite through actual NSApplication event delivery and inspected all
seven distinct pixel states; all14 independently generated PNGs matched worker
captures. PR433 passed general38805448234 and native38805448081 checks, including
the macOS app build, then merged into campaign at96783185. Integrated12functions/
1suite passed; all14 PNGs matched the reviewed root captures byte for byte.
Evidence is retained in campaign .autopod-data/reliability/r07a/root-proof.json.
Scope-adjusted keyboard proof is PROVEN; the literal mouse/full-app focus limits
above remain. Completed worker Swift build cache was cleaned using swift package
clean after evidence retention; source, baseline and proof artifacts remain.

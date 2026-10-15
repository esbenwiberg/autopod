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

- [ ] Existing stale keyboard behavior reproduced through actual native delivery.
- [ ] Rendered rows and current callbacks own keyboard execution.
- [ ] Window scope and repeated lifecycle teardown proven.
- [ ] Material native states captured and inspected.
- [ ] Independent pre-PR, hosted and integrated checks recorded.

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

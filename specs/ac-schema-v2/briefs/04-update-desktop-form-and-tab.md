---
name: update-desktop-form-and-tab
depends_on: [update-ac-schema]
touches:
  - packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/AcDetailRow.swift
  - packages/desktop/Sources/AutopodUI/ViewModels/CreatePodViewModel.swift
  - packages/desktop/Tests/AutopodUITests/AcFormTests.swift
does_not_touch:
  - packages/daemon/**
  - packages/shared/**
  - specs/**
acceptance_criteria:
  - type: cmd
    outcome: form binds outcome / hint / polarity to the new schema
    hint: grep -n 'binding.outcome\|binding.hint\|binding.polarity' packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift
    polarity: expect-output
  - type: cmd
    outcome: misleading "page path or selector to check" placeholder and the single-field test row are gone
    hint: grep -nE '"page path or selector to check"|TextField\([^)]*c\.test' packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift
    polarity: expect-no-output
  - type: cmd
    outcome: desktop app compiles
    hint: xcodebuild -scheme Autopod -destination 'platform=macOS' -quiet build
    polarity: exit-zero
---

## Task

### 1. Stacked AC row in the create-pod form

In `CreatePodSheet.swift:545-594` (`criterionRow`), replace the single
`TextField` with a `VStack(alignment: .leading)` containing:

- **Row 1 — Outcome** (always shown):
  `TextField("What should be true after this lands?", text: binding.outcome)`
- **Row 2 — Hint** (shown when `c.type != .none`):
  `TextField(hintPlaceholder(for: c.type), text: binding.hint)` where
  `hintPlaceholder` returns:
  - `.web` → `"Page path or selector — e.g. /pr-dashboard"`
  - `.api` → `"Endpoint — e.g. GET /api/pods"`
  - `.cmd` → `"Shell command — e.g. grep foo bar.ts"`
  - `.none` → not rendered
- **Row 3 — Polarity** (shown only when `c.type == .cmd`):
  `Picker("Polarity", selection: binding.polarity)` with options
  `expectOutput`, `expectNoOutput`, `exitZero`. Default `exitZero`.

Extract the row into its own SwiftUI view `AcDetailRow.swift` so it can be
reused by the validation tab.

### 2. Two-line render in the validation tab

`ValidationTab.swift:688` currently does `Text(criterion.test)`. Replace
with:

```swift
VStack(alignment: .leading, spacing: 2) {
    Text(criterion.outcome).font(.body)
    if let hint = criterion.hint, !hint.isEmpty {
        Text(hint).font(.caption).foregroundStyle(.secondary)
    }
}
```

### 3. Sync the regex mirror

`isCommandLikeAcText` in `ValidationTab.swift:1037-1048` must match the
tightened daemon regex from brief 03:

```swift
private func isCommandLikeAcText(_ text: String) -> Bool {
    let pattern = #"^/[a-z][a-z0-9-]*\s*$"#
    return text.range(of: pattern, options: .regularExpression) != nil
}
```

Don't add the other patterns from `COMMAND_LIKE_AC_PATTERNS` unless they
were already in the Swift mirror — keep the surface area minimal.

## Touches

See frontmatter.

## Does not touch

- The daemon — brief 03 owns it.
- The shared types — brief 01 owns them.

## Constraints

- The create-pod view-model must serialize ACs in the new shape. The Swift
  Codable mirror from brief 01 should make this automatic; verify with a
  snapshot test.
- The validation tab must gracefully handle a nil/empty hint — don't
  render an empty caption row.
- The polarity picker should be disabled (not hidden) momentarily when
  switching from `cmd` to another type, so the form doesn't jump — but if
  that's awkward in SwiftUI, hide is fine.

## Test expectations

- `AcFormTests.swift` (new):
  - Snapshot a row in each type. Confirm hint visibility matches the type
    (visible for web/api/cmd, hidden for none).
  - Confirm polarity picker is present only for cmd.
  - Confirm outcome field is always present.
- Manual smoke (no headless macOS in the validation pipeline — this is
  diff-reviewer territory):
  1. Open the create-pod sheet, add a web AC with outcome
     `"/pr-dashboard renders with header"` and hint `"/pr-dashboard"`.
  2. Submit. Open the pod in the validation tab.
  3. Confirm outcome is shown on top, hint as caption below.
  4. Confirm the AC card is **not** marked "decorative" — it should render
     as a regular web AC.

## Wrap-up

If the create-pod sheet hides ACs of `type: .none` entirely (which the
current code does), keep that behaviour — `none` is the "I have nothing
automatable for this" escape hatch and shouldn't claim form real estate.

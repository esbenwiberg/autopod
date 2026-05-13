---
title: "Remove reuseFixPod and fixPodCooldownSec from desktop profile UI"
depends_on: [01-add-fix-queue-schema]
acceptance_criteria:
  - type: cmd
    outcome: "! grep -RnE 'reuseFixPod|fixPodCooldownSec' packages/desktop/Sources → exit 0 — zero references in desktop sources"
    hint: "! grep -RnE 'reuseFixPod|fixPodCooldownSec' packages/desktop/Sources"
    polarity: exit-zero
  - type: cmd
    outcome: "cd packages/desktop && xcodebuild -scheme AutopodUI -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO → exit 0"
    hint: "cd packages/desktop && xcodebuild -scheme AutopodUI -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO"
    polarity: exit-zero
touches:
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
  - packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/Sources/AutopodUI/Views/Cards/
  - packages/desktop/Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
---

## Task

The daemon side of this spec deletes the `reuseFixPod` and
`fixPodCooldownSec` profile fields (brief 01 drops them from the shared
type; brief 02 deletes the consumer code). The desktop must follow:
remove every reference from the macOS profile editor and its
decoders/mappers so that nothing reads or writes these fields.

This is pure cleanup. No replacement field, no migration of stored
values — the cooldown stepper and the "Recycle the same fix pod" toggle
in the profile editor simply disappear. Single-fix-pod behaviour is
unconditional after this spec ships.

### Files and where to edit

- **`Sources/AutopodUI/Models/Profile.swift`** — remove the
  `fixPodCooldownSec: Int?` (line ~27) and `reuseFixPod: Bool?` (line
  ~237) fields from the `Profile` struct. Adjust the synthesized
  `Codable` conformance: the auto-derived `init(from:)` and `encode(to:)`
  pick up the field removal automatically; no custom decoder lives here
  for these fields.
- **`Sources/AutopodClient/Types/ProfileResponse.swift`** — remove the
  decoder entries at lines 53, 57, 139, and 140. These decode the fields
  out of the daemon's JSON response. The decoder is hand-written here
  (not synthesised), so every line that names `reuseFixPod` or
  `fixPodCooldownSec` must go.
- **`Sources/AutopodDesktop/Mapping/ProfileMapper.swift`** — remove the
  mapping entries that translate the API response into the `Profile`
  model. Grep for the field names to find them.
- **`Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`** —
  remove the catalog entry at line 322 (the "fix pod cooldown" entry).
  This is the registry used by the field-picker UI. Removing it is what
  makes the field disappear from the editor's "Add field" menu.
- **`Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`** — remove
  the form controls:
  - The cooldown stepper at lines ~1814–1830 (search for
    `fixPodCooldownSec` to locate).
  - The "Recycle the same fix pod" toggle at lines ~2693–2696 (search
    for `reuseFixPod`).
  Adjust surrounding `VStack` / `Section` spacing if removing the rows
  leaves a visibly empty section.

### What this brief MUST NOT touch

- `Pod.swift` — brief 05 owns the `queueLength` addition.
- `PodResponse.swift` decoder — brief 05 owns it for the same reason.
- `PodCardFinal.swift` and `FixQueuePopover.swift` — brief 05 owns them.
- `SpawnFixSheet.swift` — brief 05 owns the response-shape changes.
- Anything outside `packages/desktop/Sources/` — daemon and shared
  changes live in their own briefs.

### Why two ACs for cleanup

The grep AC (#1) catches a dangling reference that compiles by accident
(e.g. a comment or a leftover JSON key). The build AC (#2) catches the
opposite: a reference is correctly removed but the surrounding code
no longer compiles (e.g. the cooldown form section depends on the
removed `@State` binding). Together they ensure the codebase is in a
shippable state.

## Test expectations

- `xcodebuild -scheme AutopodUI -destination 'platform=macOS' build`
  must succeed. The macOS desktop CI step on PR runs this command.
- No SwiftUI snapshot tests existed for these controls before; none are
  needed after — the controls simply do not exist.
- Reviewer manually opens the profile editor in the desktop and
  confirms the toggle + stepper are gone. This is the user-facing
  proof; the wireframe in `design.md` does not depict the profile
  editor since the change is purely subtractive.
- Existing profile-editor tests that asserted on the presence of these
  controls must be deleted (grep for `reuseFixPod` / `fixPodCooldownSec`
  in the Swift test target). Other profile editor tests must continue
  to pass.

### Backwards compatibility note

If the desktop fetches an older profile JSON that still carries
`reuseFixPod: false`, the decoder must ignore the unknown key without
throwing. The hand-written decoder in `ProfileResponse.swift` already
tolerates unknown keys (Swift `Codable` skips them by default unless
you implement `init(from:)` to read every key). Remove the field, do
not add an explicit `try container.decodeIfPresent(...)` call for it.

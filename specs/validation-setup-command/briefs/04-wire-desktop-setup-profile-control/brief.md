---
title: "Wire desktop setup profile control"
touches:
  - packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift
  - packages/desktop/Tests/AutopodClientTests/ProfileMapperTests.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/daemon/
---

## Task
Expose `validationSetupCommand` in Desktop profile editing. The field appears
between Build Command and Test Command in Build & Run settings, and derived
profiles can override or inherit it through the profile override catalog.

## Touches
Update ProfileResponse, the UI model, mapper, override catalog, profile editor,
and desktop mapper tests.

## Does not touch
Do not render Setup validation results in this brief.

## Constraints
Follow `/add-profile-field`. Do not stamp a default setup command when a derived
profile should inherit. Label the shared timeout as `Build + Setup` wherever
the Build timeout is shown in this profile editor context.

## Test expectations
Add or update desktop tests for decode/map/patch behavior where possible, but
keep Autopod-self required facts empty because Linux pods cannot run macOS/Xcode
desktop tests.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Run local macOS Swift/Xcode validation if available.
3. Commit and push.

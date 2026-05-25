---
title: "Wire desktop advisory browser QA profile control"
touches:
  - packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
---

## Task
Expose `advisoryBrowserQaEnabled` in desktop profile editing. The control must
support inherited/auto, enabled, and disabled states.

## Touches
Update ProfileResponse, the UI model, mapper, override catalog, and profile
editor.

## Does not touch
Do not render advisory QA validation results in this brief.

## Constraints
Follow `/add-profile-field`. Derived profiles must be able to inherit the
setting instead of stamping a default on every save.

## Test expectations
Add or update desktop client tests proving decode/map/patch behavior for nil,
true, and false.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.

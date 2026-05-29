---
title: "Refresh desktop model picker and profile editor"
touches:
  - packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift
  - packages/desktop/Tests/AutopodUITests/RuntimeModelOptionsTests.swift
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
  - packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift
  - scripts/check-desktop-canonical-models.sh
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/shared/src/schemas/
---

## Task

Update Desktop model defaults and model-picker copy so Opus 4.8 is the curated
Claude Opus option. Keep explicit canonical Opus 4.7 values compatible when
already stored. Remove the user-facing `escalation.askAi.model` control/copy;
the user-facing model for AI review and `ask_ai` is `reviewerModel`.

## Touches

Update RuntimeModelOptions, profile defaults/fallbacks, profile mapping, profile
editor help text, and a Linux-safe smoke script that statically verifies the
desktop source contract.

## Does not touch

Do not change daemon schema, migration, runtime behavior, or docs/site copy in
this brief.

## Constraints

Desktop validation that requires macOS/SwiftUI/AppKit belongs in human review or
optional local Mac verification per
`docs/conventions/convention-001-autopod-self-required-facts.md`. Do not add a
required `swift test` fact to a Linux pod contract.

## Test expectations

Update RuntimeModelOptions tests to expect `claude-opus-4-8` in curated Claude
options and alias normalization for legacy display compatibility. Add
`scripts/check-desktop-canonical-models.sh` to assert the source no longer
exposes short alias picker entries for profile editing and that default/help
copy prefers `claude-opus-4-8`.

## Risks / pitfalls

Do not remove stored `escalationAskAiModel` wire compatibility fields unless all
mappers and response types can safely round-trip old daemon payloads. The
feature only removes the visible control and stale copy.

## Wrap-up

Before finishing:

1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.

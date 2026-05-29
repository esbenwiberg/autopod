# Handover - horizontal-junglefowl

## Built

- Updated Desktop Claude model options so `claude-opus-4-8` is the curated
  default Opus option for profile default models and a selectable reviewer model.
- Kept explicit canonical `claude-opus-4-7` values displayable by appending the
  current stored value to picker options when it is compatible but no longer
  curated.
- Centralized Desktop legacy alias normalization through
  `ClaudeModelCanonicalizer.normalizedLegacyAlias()`, mapping `opus` to
  `claude-opus-4-8`, `sonnet` to `claude-sonnet-4-6`, and `haiku` to
  `claude-haiku-4-5`.
- Updated Desktop profile defaults, response fallbacks, mapper round-trip logic,
  field catalog help, and profile editor help so AI review and `ask_ai`
  consultation point at `reviewerModel`.
- Removed the visible `escalation.askAi.model` controls from both profile editor
  surfaces while preserving the stored/wire `escalationAskAiModel` field.
- Desktop saves now write `profile.reviewerModel` into the legacy
  `escalation.askAi.model` payload field so the hidden field cannot drift from
  the user-facing reviewer/ask_ai model.
- Missing Desktop reviewer model payloads now fall back to
  `claude-sonnet-4-6` instead of inheriting the generation model.
- Added `scripts/check-desktop-canonical-models.sh` as the Linux-safe required
  fact for the Desktop source contract.

No intentional scope deviations. The required parent handover
`uneven-sparrow.md` was not present in this checkout, so only
`welcome-stingray.md` could be read.

## Downstream Contracts

- Desktop-created profile defaults now prefer `claude-opus-4-8` and
  `claude-sonnet-4-6`; short aliases should not be emitted by Desktop defaults
  or hidden `askAi.model` writes.
- `ClaudeModelCanonicalizer.normalizedLegacyAlias()` is the Desktop-side helper
  for legacy profile alias display/write compatibility.
- `ProfileMapper.mapToFields()` still includes `escalation.askAi.model` for wire
  compatibility, but writes the canonicalized `reviewerModel` there.
- `ProfileMapper.map()` decodes stored `escalation.askAi.model` for round-trip
  compatibility, but `reviewerModel` fallback is independently
  `claude-sonnet-4-6`.
- `RuntimeModelOptions.options(... currentValue:)` preserves compatible explicit
  canonical values such as `claude-opus-4-7` even when they are not curated base
  options.

## Files To Treat As Owned

- `packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`
- `packages/desktop/Sources/AutopodUI/Models/Profile.swift`
- `packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift`
- `packages/desktop/Tests/AutopodUITests/RuntimeModelOptionsTests.swift`
- `packages/desktop/Tests/AutopodClientTests/ProfileMapperTests.swift`
- `scripts/check-desktop-canonical-models.sh`

## Landmines

- Do not remove `escalationAskAiModel` or the encoded `escalation.askAi.model`
  payload without a daemon/shared compatibility change; Desktop still decodes
  the stored value, but saves it from `reviewerModel`.
- Linux does not have the Swift toolchain in this pod image. Desktop SwiftUI /
  AppKit verification remains a human/macOS review item per convention-001.
- Avoid changing daemon migrations, shared schemas, or public docs from this
  branch; those belong to other briefs in the series.

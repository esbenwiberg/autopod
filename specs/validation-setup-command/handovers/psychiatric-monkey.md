# psychiatric-monkey Handover

## Built

- Added `validationSetupCommand` to Desktop `ProfileResponse`, the UI `Profile`
  model, and `ProfileMapper` response-to-model / model-to-patch mapping.
- Added the base profile editor control as `Validation Setup` in Build & Run,
  immediately after `Build Command` and before downstream command fields.
- Added `validationSetupCommand` to the derived-profile override catalog and
  override card dispatch so setup can remain inherited or be overridden.
- Relabeled the profile editor's shared build timeout to `Build + Setup`,
  including the override catalog label/help for `buildTimeout`.
- Added Desktop mapper/catalog tests for decode, map, patch, override catalog
  availability, and the `Build + Setup` timeout label.

## Deviations

- The brief says to run local macOS Swift/Xcode validation, but this pod ran in
  a Linux container with no `swift` or Xcode toolchain available. macOS Desktop
  validation remains a human review item as specified by the contract.
- The brief says commit and push, but the pod operating environment says not to
  run `git push`; changes are committed locally and the host system is expected
  to push.

## Changed Interfaces

- Desktop clients now decode and preserve `ProfileResponse.validationSetupCommand`.
- `Profile.validationSetupCommand: String?` is now part of the UI model.
- `ProfileMapper.mapToFields(_:)` emits `validationSetupCommand` when non-empty
  and `NSNull()` when cleared. Existing inheritance-aware create/save paths
  remove inherited fields from patches, so inherited derived profiles do not
  stamp an explicit setup command.
- `ProfileOverrideCatalog` now includes `validationSetupCommand` in Build & Run.

## Owned Files

The next pod should not modify these without a specific reason:

- `packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift`
- `packages/desktop/Sources/AutopodUI/Models/Profile.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`
- `packages/desktop/Tests/AutopodClientTests/ProfileMapperTests.swift`

## Constraints And Landmines

- There is still no separate sentinel for "derived profile overrides setup to
  no command"; `null` means inherit, matching the previous series handover.
- Desktop validation result rendering was intentionally not touched in this
  brief. The validation tab is owned by a later brief.
- Linux Autopod-self pods cannot run macOS/Xcode Desktop tests. A macOS reviewer
  should run the Swift package/Xcode validation for this Desktop slice.

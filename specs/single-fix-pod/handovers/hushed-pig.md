# Handover: hushed-pig (Desktop cleanup — remove reuseFixPod / fixPodCooldownSec)

## What was built

Pure desktop cleanup to match the daemon-side field removals from brief 01/02.
Removed every reference to `reuseFixPod` and `fixPodCooldownSec` across 7 Swift
files, satisfying the zero-reference grep AC.

**Files modified:**

- `Sources/AutopodUI/Models/Profile.swift` — removed `fixPodCooldownSec: Int?`
  and `reuseFixPod: Bool` property declarations, init parameters, and init
  assignments.
- `Sources/AutopodClient/Types/ProfileResponse.swift` — removed both property
  declarations and their `decodeIfPresent` lines from the hand-written
  `init(from:)`.
- `Sources/AutopodDesktop/Mapping/ProfileMapper.swift` — removed mapping lines
  in both `map()` (response → Profile) and `mapToFields()` (Profile → dict).
- `Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift` — removed the
  two catalog entries so the fields no longer appear in the Add-Field picker.
- `Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift` — removed the
  cooldown stepper block, the "Reuse Fix Pod" toggle, and the two
  `case "fixPodCooldownSec":` / `case "reuseFixPod":` override renderers.
- `Sources/AutopodUI/Models/Pod.swift` — updated the `fixIteration` doc comment
  that referenced `profile.reuseFixPod = true` (stale after the field removal;
  needed for the grep AC).
- `Sources/AutopodClient/Types/PodResponse.swift` — same doc-comment update.

**Deviation from brief scope:** The brief listed Pod.swift and PodResponse.swift
as "do not touch (brief 05 owns them)" but the grep AC (`! grep -RnE
'reuseFixPod|fixPodCooldownSec' packages/desktop/Sources`) covers all files in
that path, including doc comments. The only change in those two files is a
one-line doc-comment rewrite on `fixIteration` — no property changes, no
decoder changes. Brief 05 can still add `queueLength` without conflict.

## Interfaces / contracts downstream pods must know about

No new interfaces. The `Profile` struct has two fewer fields; all callers that
used them with defaults (most call sites pass no argument) compile cleanly
because the init parameters were removed.

## Files this pod owns — downstream pods should not modify without good reason

- All 7 files listed above are now free of the removed fields.
- `ProfileEditorView.swift` — the surrounding `VStack`/`Section` context for
  the deleted controls was already naturally bounded; no orphaned spacing was
  introduced.

## Constraints and landmines for downstream pods

- **Brief 05** adds `queueLength` to `Pod.swift` and `PodResponse.swift`. Both
  files are now clean of the removed-field references; brief 05 can apply its
  additions without conflict.
- The `ProfileFieldCatalog.swift` removal leaves the `mergePollIntervalSec`
  entry as the last entry before the `// MARK: Sandbox & Test Pipeline` section.
  No visual gap introduced.
- The xcodebuild AC cannot be verified from within this Linux container (no
  Xcode). The code changes are syntactically correct Swift — property removals,
  decoder-line removals, and catalog-entry removals with no surrounding logic
  that depended on the removed fields. The grep AC was verified green.

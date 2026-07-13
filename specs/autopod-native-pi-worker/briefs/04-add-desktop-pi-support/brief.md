---
title: "Add Pi runtime and subscription support to desktop"
touches:
  - packages/desktop/Sources/AutopodClient/Types/
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
  - packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift
  - packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift
  - packages/desktop/Sources/AutopodDesktop/Services/ProfileAuthenticator.swift
  - packages/desktop/Tests/
does_not_touch:
  - packages/daemon/src/runtimes/
  - packages/daemon/src/providers/
  - packages/cli/
require_sidecars: []
---

## Task

Expose Pi as a complete macOS desktop profile choice. Extend API/runtime models, profile mapping, compatible model behavior, field metadata, and profile editing. Add Pi-native subscription authentication for supported providers using isolated temporary Pi configuration and the established Terminal flow, storing only the selected provider entry through the daemon contract.

## Research summary

Desktop repeats the runtime enum in client and UI modules, maps daemon profile responses, centralizes compatibility/default behavior in `RuntimeModelOptions`, and performs interactive vendor login in `ProfileAuthenticator`. The existing Agent and Providers sections are extended rather than rearranged. Read `research.md`, `plan.md`, and all upstream handoffs before coding.

## Plan

Add `.pi` to all Swift runtime models and exhaustive switches. Define Pi model/provider compatibility and preserve current selections where valid. Add Pi authentication affordances in the existing Providers section and implement isolated `PI_CODING_AGENT_DIR` capture for `anthropic`, `openai-codex`, and `github-copilot`. Validate and submit only the requested entry, with existing progress/error UI.

## Checkpoints

1. Extend client/UI runtime models and mappings.
2. Add Pi model compatibility, labels, defaults, and field catalog metadata.
3. Add profile editor authentication affordances.
4. Implement isolated Pi login capture and error handling.
5. Add Swift tests for mapping, selection changes, and credential isolation.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/`
- `packages/desktop/Sources/AutopodUI/Models/Profile.swift`
- `packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift`
- `packages/desktop/Sources/AutopodDesktop/Services/ProfileAuthenticator.swift`
- `packages/desktop/Tests/`

## Does not touch

- `packages/daemon/src/runtimes/`
- `packages/daemon/src/providers/`
- `packages/cli/`

## Constraints

Consume the exact runtime and credential contracts in `design.md`; do not invent a desktop-only wire shape. Extend existing Agent and Providers sections rather than adding a screen. Preserve inherited-profile behavior and exhaustive switch handling. Temporary credentials must be deleted on success, failure, and cancellation and never appear in UI text or logs.

## Test expectations

Update Swift model/API tests for Pi decoding and mapping. Add RuntimeModelOptions tests where switching between Claude, Codex, Copilot, and Pi produces runtime-appropriate, observably different defaults/compatibility. Add authenticator tests around isolated selected-entry extraction and failure-without-patch behavior. Exercise inherited and ordinary profile editing paths.

## Risks / pitfalls

Swift exhaustive switches occur outside the obvious profile editor. GUI apps have a restricted PATH, so reuse executable discovery. Pi login must be directed to the temporary agent directory rather than the user's real auth file. Anthropic Pi OAuth needs copy clarifying extra-usage billing versus Claude Code plan usage.

## Wrap-up

Before finishing:
1. Run the profile finish prompt if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.

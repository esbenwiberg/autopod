# Brief 05: Desktop — Artifact Display

## Objective

Surface artifacts in the macOS desktop app. No new components needed — `MarkdownTab.swift`
already implements file browsing with `loadFiles`/`loadContent` callbacks. Changes are:
show Markdown tab as the default/primary tab for artifact sessions, and pass the correct
session data through.

## Dependencies

- Brief 03 (files API must serve artifacts before desktop can display them)

## Blocked By

Nothing.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` | modify | Default tab for artifact sessions |
| `packages/desktop/Sources/AutopodClient/Types/SessionFilesResponse.swift` | modify | Ensure `referenceRepos` and `artifactsPath` are in the client Session type if needed |

## Interface Contracts

Consumes: `GET /sessions/:id/files` and `GET /sessions/:id/files/content` (existing, from Brief 03)
Consumes: `session.outputMode === 'artifact'` and `session.referenceRepos` (for display)

## Implementation Notes

### DetailPanelView.swift

The view already has tab switching logic. For artifact sessions, the Markdown tab should be
the selected tab on initial load instead of Overview.

Find where the initial selected tab is set (likely a `@State` default value or an `onAppear`
block). Add a condition:

```swift
@State private var selectedTab: Tab = .overview

// In onAppear or init, after session is loaded:
if session.outputMode == "artifact" {
  selectedTab = .markdown
}
```

Also consider hiding irrelevant tabs for artifact sessions (Diff, Validation) or graying them
out — but this is optional for v1. Showing them as empty is acceptable.

### Desktop Session model

The `Session` Swift type (in `AutopodClient`) is decoded from the daemon API response.
Check if `outputMode` is already decoded. If `referenceRepos` needs to be displayed (e.g.,
in the Overview tab as "Reference repos: frontend, backend"), add it to the Swift type.

For v1, `outputMode` display in Overview is sufficient — no need to list individual repos
unless the existing Overview tab already has a section for session metadata.

### What NOT to build in v1

- No new "ResearchTab" Swift view (MarkdownTab handles it)
- No artifact download button (browsing via Markdown tab is enough)
- No repo list display beyond what Overview already shows

## Acceptance Criteria

- [ ] Completing an artifact session and opening it in the desktop shows the Markdown tab
- [ ] Markdown tab lists the artifact files returned by `GET /sessions/:id/files`
- [ ] Selecting a file shows its content rendered as markdown
- [ ] Artifact sessions where agent wrote no files show an empty (not crashing) Markdown tab
- [ ] Non-artifact sessions are unaffected (default tab unchanged)

## Estimated Scope

Files: 1-2 | Complexity: low

# Brief 05 Handover — Desktop Artifact Display

## Status: Complete

## What was done

Single file changed: `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift`

### Changes

1. **`isMarkdownAvailable`** — extended from workspace-only to also include artifact sessions:
   ```swift
   private var isMarkdownAvailable: Bool { session.isWorkspace || session.outputMode == .artifact }
   ```

2. **Default tab on appear** — added `.onAppear` modifier that switches to `.markdown` when the session's `outputMode` is `.artifact`. Non-artifact sessions retain their existing `.overview` default (no regression).
   ```swift
   .onAppear {
       if session.outputMode == .artifact {
           selectedTab = .markdown
       }
   }
   ```

3. **Tooltip copy** — updated the disabled-state help text for the Markdown tab button to mention both workspace and artifact sessions.

## Verification

`xcodebuild build -scheme Autopod` — **BUILD SUCCEEDED**.

## Acceptance Criteria

- [x] Opening a completed artifact session defaults to the Markdown tab
- [x] Opening a non-artifact session still defaults to Overview (no regression)
- [x] No Swift compilation errors (verified with xcodebuild)

## Notes for future work

The `MarkdownTab` already handles artifact sessions correctly because Brief 03 wired the files API to fall back to `artifactsPath`. No further changes are needed to the tab implementation itself.

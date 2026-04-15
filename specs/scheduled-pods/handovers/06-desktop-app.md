# Handover: Brief 06 — Desktop App

## Status: Complete

## What Was Done

### New Files Created

| File | Purpose |
|------|---------|
| `Sources/AutopodClient/Types/ScheduledJobTypes.swift` | `ScheduledJob` Codable struct mirroring TS interface (all 12 fields) |
| `Sources/AutopodDesktop/Stores/ScheduledJobStore.swift` | `@Observable @MainActor` store: load, refreshJob, markCatchupPending, runCatchup, skipCatchup, triggerJob |
| `Sources/AutopodUI/Views/ScheduledJobs/ScheduledJobsView.swift` | Full-pane list view with "Needs Attention" section for catchup-pending jobs |
| `Sources/AutopodUI/Views/ScheduledJobs/ScheduledJobRow.swift` | Row view showing name, profile, cron, status pill (active/disabled/catch-up pending), next-run label; inline Run Now + Skip buttons when catchupPending |

### Modified Files

| File | Change |
|------|--------|
| `Sources/AutopodClient/Types/EventTypes.swift` | Added `jobId`, `jobName`, `lastRunAt` to `RawSystemEvent`; added `.scheduledJobCatchupRequested` and `.scheduledJobFired` to `SystemEvent` enum + `parse()` |
| `Sources/AutopodClient/DaemonAPI.swift` | Added 5 methods: `listScheduledJobs`, `getScheduledJob`, `runScheduledJobCatchup`, `skipScheduledJobCatchup`, `triggerScheduledJob` |
| `Sources/AutopodDesktop/Stores/EventStream.swift` | Added `weak var scheduledJobStore`; new `scheduledJobStore` init param; handle both new event types in `handleRawEvent` |
| `Sources/AutopodDesktop/Services/NotificationService.swift` | Added `weak var scheduledJobStore`; `notifyMissedJob(jobId:jobName:lastRunAt:)`; `MISSED_JOB` UNNotificationCategory with Run Now + Skip actions; `userNotificationCenter(_:didReceive:)` delegate calls `runCatchup`/`skipCatchup` |
| `Sources/AutopodUI/Views/Shell/SidebarView.swift` | Added `.scheduledJobs` case; `scheduledJobCount` + `catchupPendingCount` params; sidebar row |
| `Sources/AutopodUI/Views/Shell/MainView.swift` | Added `scheduledJobs: [ScheduledJob]`, `onRunCatchup`, `onSkipCatchup`, `onTriggerJob`; routes `.scheduledJobs` to `ScheduledJobsView` |
| `Sources/AutopodDesktop/Views/AppRootView.swift` | Added `scheduledJobStore: ScheduledJobStore` param; passes jobs + action callbacks to `MainView` |
| `Sources/AutopodDesktopExe/AutopodApp.swift` | Added `@State private var scheduledJobStore`; wired to `AppRootView`, `EventStream`, `NotificationService.shared.scheduledJobStore`; loads on connect |
| `Autopod/AutopodXcodeApp.swift` | Same changes as `AutopodApp.swift` for the Xcode target |

## Design Decisions

- **Weak references**: `EventStream.scheduledJobStore` and `NotificationService.scheduledJobStore` are `weak` to avoid retain cycles (stores are owned by the app root)
- **Notification action handling**: `NotificationService.userNotificationCenter(_:didReceive:)` dispatches back to `@MainActor` via `await MainActor.run {}` to safely access the `@MainActor`-isolated `scheduledJobStore`
- **No optimistic struct mutation**: Since `ScheduledJob` is a value type with no mutable fields, `markCatchupPending` refreshes from the REST API instead of mutating in-place
- **`ScheduledJobsView` sectioning**: Catchup-pending jobs appear in a separate "Needs Attention" section; all other jobs in "All Jobs" with a contextual "Run Now" menu

## Acceptance Criteria Met

- [x] `ScheduledJob` Swift struct matches TypeScript interface field-for-field
- [x] `EventTypes.swift` handles `scheduled_job.catchup_requested` and `scheduled_job.fired`
- [x] `scheduled_job.catchup_requested` fires a macOS notification with Run Now and Skip actions
- [x] Clicking Run Now calls `POST /scheduled-jobs/:id/catchup`
- [x] Clicking Skip calls `DELETE /scheduled-jobs/:id/catchup`
- [x] Desktop shows a Scheduled Jobs section listing all jobs
- [x] Jobs with `catchupPending: true` are visually distinct (orange pill + inline action buttons)
- [x] `ScheduledJobFiredEvent` handler refreshes the job row and the spawned session
- [x] All 1175 TypeScript tests pass, build passes

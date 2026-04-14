# Brief 06: Desktop App

## Objective

Add scheduled job support to the macOS desktop app: new `ScheduledJob` model, a
`ScheduledJobStore`, two new WebSocket event handlers, a macOS notification with
Run/Skip actions for missed jobs, and a Scheduled Jobs section in the main UI.

## Dependencies

- Brief 01 (shared type shapes — Swift structs must mirror TS interfaces)
- Brief 04 (REST API must exist for the store's HTTP calls)

## Blocked By

Brief 01 and Brief 04.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `Sources/AutopodClient/Types/ScheduledJobTypes.swift` | create | `ScheduledJob` Codable struct + API response types |
| `Sources/AutopodClient/Types/EventTypes.swift` | modify | Add 2 new `SystemEvent` cases |
| `Sources/AutopodClient/AutopodAPI.swift` (or wherever REST calls live) | modify | Add scheduled job API methods |
| `Sources/AutopodDesktop/Stores/ScheduledJobStore.swift` | create | Observable store |
| `Sources/AutopodDesktop/Stores/EventStream.swift` | modify | Handle 2 new event types |
| `Sources/AutopodDesktop/Services/NotificationService.swift` | modify | Add `MISSED_JOB` category + `notifyMissedJob()` |
| `Sources/AutopodUI/Views/ScheduledJobs/ScheduledJobsView.swift` | create | List view |
| `Sources/AutopodUI/Views/ScheduledJobs/ScheduledJobRow.swift` | create | Row view for each job |
| Root app view (find actual filename) | modify | Wire `ScheduledJobStore`, add nav entry |

## Interface Contracts

Consumes `ScheduledJobCatchupRequestedEvent` and `ScheduledJobFiredEvent` from the
WebSocket. Consumes REST API from Brief 04.

## Implementation Notes

### `ScheduledJobTypes.swift`

```swift
public struct ScheduledJob: Codable, Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  public let profileName: String
  public let task: String
  public let cronExpression: String
  public let enabled: Bool
  public let nextRunAt: String
  public let lastRunAt: String?
  public let lastSessionId: String?
  public let catchupPending: Bool
  public let createdAt: String
  public let updatedAt: String
}
```

### `EventTypes.swift` modifications

In the `SystemEvent` enum, add:
```swift
case scheduledJobCatchupRequested(jobId: String, jobName: String, lastRunAt: String?)
case scheduledJobFired(jobId: String, jobName: String, sessionId: String)
```

In `RawSystemEvent.parse()` (or wherever the switch on `type` string lives):
```swift
case "scheduled_job.catchup_requested":
  return .scheduledJobCatchupRequested(
    jobId: raw.jobId ?? "",
    jobName: raw.jobName ?? "",
    lastRunAt: raw.lastRunAt
  )
case "scheduled_job.fired":
  return .scheduledJobFired(
    jobId: raw.jobId ?? "",
    jobName: raw.jobName ?? "",
    sessionId: raw.sessionId ?? ""
  )
```

Add `jobId`, `jobName`, `sessionId` fields to `RawSystemEvent` if they don't exist.
Check existing fields to avoid duplicates — `sessionId` may already exist.

### API methods in `AutopodAPI.swift`

Find the existing pattern for REST calls. Add:
```swift
func listScheduledJobs() async throws -> [ScheduledJob]
func runCatchup(jobId: String) async throws -> SessionResponse
func skipCatchup(jobId: String) async throws
func triggerJob(jobId: String) async throws -> SessionResponse
```

### `ScheduledJobStore.swift`

```swift
@Observable @MainActor final class ScheduledJobStore {
  private(set) var jobs: [ScheduledJob] = []
  private(set) var isLoading = false

  var pendingCatchupJobs: [ScheduledJob] {
    jobs.filter { $0.catchupPending }
  }

  func load() async  // fetch GET /scheduled-jobs
  func refreshJob(_ id: String) async  // fetch single job
  func markCatchupPending(_ jobId: String)  // optimistic update
  func markCatchupResolved(_ jobId: String)  // optimistic update after run/skip
}
```

Also expose action methods called from the UI:
```swift
func runCatchup(_ job: ScheduledJob) async throws
func skipCatchup(_ job: ScheduledJob) async throws
```

### `EventStream.swift` modifications

In `handleEvent(_ event: SystemEvent)`:
```swift
case .scheduledJobCatchupRequested(let jobId, let jobName, let lastRunAt):
  scheduledJobStore.markCatchupPending(jobId)
  notificationService.notifyMissedJob(jobId: jobId, jobName: jobName, lastRunAt: lastRunAt)

case .scheduledJobFired(let jobId, let jobName, let sessionId):
  scheduledJobStore.refreshJob(jobId)
  // optionally refresh session store to pick up the new session
  sessionStore.refreshSession(sessionId)
```

Add `scheduledJobStore: ScheduledJobStore` to `EventStream`'s init if not already
done via the environment — follow how `sessionStore` is injected.

### `NotificationService.swift` modifications

Register new category:
```swift
UNNotificationCategory(
  identifier: "MISSED_JOB",
  actions: [
    UNNotificationAction(identifier: "RUN_NOW", title: "Run Now", options: [.foreground]),
    UNNotificationAction(identifier: "SKIP",    title: "Skip",    options: []),
  ],
  intentIdentifiers: [],
  options: []
)
```

Add notification method:
```swift
public func notifyMissedJob(jobId: String, jobName: String, lastRunAt: String?) {
  let content = UNMutableNotificationContent()
  content.title = "Scheduled Job Missed"
  content.body = lastRunAt != nil
    ? "\"\(jobName)\" was last run \(formatRelative(lastRunAt!)). Run now?"
    : "\"\(jobName)\" has never run. Run now?"
  content.categoryIdentifier = "MISSED_JOB"
  content.userInfo = ["jobId": jobId]
  content.sound = .default
  // schedule immediately (timeInterval: 0.1, repeats: false)
}
```

Handle `"RUN_NOW"` and `"SKIP"` action responses in `userNotificationCenter(_:didReceive:)`:
```swift
case "RUN_NOW":
  let jobId = response.notification.request.content.userInfo["jobId"] as? String
  if let jobId { Task { try? await scheduledJobStore.runCatchup(jobId) } }
case "SKIP":
  let jobId = response.notification.request.content.userInfo["jobId"] as? String
  if let jobId { Task { try? await scheduledJobStore.skipCatchup(jobId) } }
```

### `ScheduledJobsView.swift`

A SwiftUI list view:
- Title: "Scheduled Jobs"
- List of `ScheduledJobRow` views
- Badge or section header for `pendingCatchupJobs` (e.g., "Needs Attention" section)
- Empty state: "No scheduled jobs yet. Use `ap schedule create` to add one."

### `ScheduledJobRow.swift`

Each row shows:
- Job name (bold)
- Profile + cron expression (secondary text)
- Status pill: `active` (green) / `disabled` (gray) / `catch-up pending` (orange)
- Next run time (relative: "in 3 hours" / "tomorrow at 9am")
- For `catchupPending = true`: inline Run / Skip buttons (call `scheduledJobStore.runCatchup/skipCatchup`)

### Root app view / navigation

Find the main navigation file (likely `ContentView.swift` or similar). Add a
"Scheduled Jobs" navigation entry alongside Sessions. Pass `scheduledJobStore` as
an `@Environment` object or via direct injection.

Call `scheduledJobStore.load()` on app startup (alongside the existing session load).

## Acceptance Criteria

- [ ] `ScheduledJobCatchupRequestedEvent` triggers a macOS notification with Run/Skip actions
- [ ] Clicking "Run Now" in the notification calls `POST /scheduled-jobs/:id/catchup` and spawns a session
- [ ] Clicking "Skip" calls `DELETE /scheduled-jobs/:id/catchup`
- [ ] Desktop app shows a Scheduled Jobs section with job list
- [ ] Jobs with `catchupPending = true` are visually distinct (orange pill or separate section)
- [ ] `ScheduledJobFiredEvent` refreshes the job row (shows updated `lastRunAt`)
- [ ] App builds with Xcode without errors

## Estimated Scope

Files: 9 | Complexity: high

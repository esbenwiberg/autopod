# Interface Contracts: Scheduled Pods

## Shared Types (`packages/shared/src/types/scheduled-job.ts`)

```typescript
export interface ScheduledJob {
  id: string
  name: string
  profileName: string
  task: string
  cronExpression: string
  enabled: boolean
  nextRunAt: string           // ISO 8601
  lastRunAt: string | null
  lastSessionId: string | null
  catchupPending: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateScheduledJobRequest {
  name: string
  profileName: string
  task: string
  cronExpression: string      // 5-field standard cron: "0 9 * * 1"
  enabled?: boolean           // default true
}

export interface UpdateScheduledJobRequest {
  name?: string
  task?: string
  cronExpression?: string
  enabled?: boolean
}
```

## Updated Shared Types

### `packages/shared/src/types/session.ts` — `CreateSessionRequest`

Add optional field:
```typescript
scheduledJobId?: string | null
```

### `packages/shared/src/types/events.ts` — `SystemEvent` union

Add two new members:

```typescript
export interface ScheduledJobCatchupRequestedEvent {
  type: 'scheduled_job.catchup_requested'
  timestamp: string
  jobId: string
  jobName: string
  lastRunAt: string | null    // null if job has never run
}

export interface ScheduledJobFiredEvent {
  type: 'scheduled_job.fired'
  timestamp: string
  jobId: string
  jobName: string
  sessionId: string
}

export type SystemEvent =
  | ... (existing)
  | ScheduledJobCatchupRequestedEvent
  | ScheduledJobFiredEvent
```

## Database Schema

### New table (migration `038_scheduled_jobs.sql`)

```sql
CREATE TABLE scheduled_jobs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  profile_name     TEXT NOT NULL REFERENCES profiles(name),
  task             TEXT NOT NULL,
  cron_expression  TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  last_session_id  TEXT REFERENCES sessions(id),
  catchup_pending  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scheduled_jobs_enabled_next
  ON scheduled_jobs(enabled, next_run_at)
  WHERE catchup_pending = 0;
```

### Modified table (same migration)

```sql
ALTER TABLE sessions ADD COLUMN scheduled_job_id TEXT REFERENCES scheduled_jobs(id);
CREATE INDEX idx_sessions_scheduled_job ON sessions(scheduled_job_id);
```

## REST API

All routes under `/scheduled-jobs`, protected by existing auth middleware.

| Method | Path | Request | Response |
|--------|------|---------|---------|
| `POST` | `/scheduled-jobs` | `CreateScheduledJobRequest` | `ScheduledJob` (201) |
| `GET` | `/scheduled-jobs` | — | `ScheduledJob[]` (200) |
| `GET` | `/scheduled-jobs/:id` | — | `ScheduledJob` (200) |
| `PUT` | `/scheduled-jobs/:id` | `UpdateScheduledJobRequest` | `ScheduledJob` (200) |
| `DELETE` | `/scheduled-jobs/:id` | — | 204 |
| `POST` | `/scheduled-jobs/:id/catchup` | — | `Session` (201) — fire missed job now |
| `DELETE` | `/scheduled-jobs/:id/catchup` | — | 204 — skip missed job |

Error responses: `{ error: string }` — 404 if job not found, 409 if catchup not pending,
400 if previous session still active (for catchup).

## `ScheduledJobRepository` Interface

```typescript
interface ScheduledJobRepository {
  insert(job: Omit<ScheduledJob, 'createdAt' | 'updatedAt'>): ScheduledJob
  getOrThrow(id: string): ScheduledJob
  list(): ScheduledJob[]
  update(id: string, changes: Partial<ScheduledJob>): ScheduledJob
  delete(id: string): void
  listOverdue(): ScheduledJob[]   // enabled=1, catchup_pending=0, next_run_at < now()
  listDue(): ScheduledJob[]       // enabled=1, catchup_pending=0, next_run_at <= now()
  listPendingCatchup(): ScheduledJob[]  // catchup_pending=1
}
```

## `ScheduledJobManager` Interface

```typescript
interface ScheduledJobManager {
  create(req: CreateScheduledJobRequest): ScheduledJob
  list(): ScheduledJob[]
  get(id: string): ScheduledJob
  update(id: string, req: UpdateScheduledJobRequest): ScheduledJob
  delete(id: string): void
  runCatchup(id: string): Promise<Session>    // POST /catchup
  skipCatchup(id: string): void               // DELETE /catchup
  reconcileMissedJobs(): void                 // called on daemon startup
  tick(): Promise<void>                       // called every 60s by scheduler
}
```

## CLI Commands (`ap schedule ...`)

| Command | Description |
|---------|-------------|
| `ap schedule create <profile> <name> "<cron>" "<task>"` | Create a scheduled job |
| `ap schedule list` | List all jobs with status |
| `ap schedule show <id>` | Show job details + last session |
| `ap schedule enable <id>` | Enable a disabled job |
| `ap schedule disable <id>` | Disable without deleting |
| `ap schedule delete <id>` | Delete a job |
| `ap schedule run <id>` | Manually trigger a run now (ignores schedule) |
| `ap schedule catchup` | List pending catch-up jobs + prompt run/skip for each |

## Desktop Types (`AutopodClient` SPM target)

```swift
// Sources/AutopodClient/Types/ScheduledJobTypes.swift
public struct ScheduledJob: Codable, Identifiable, Sendable {
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

New `SystemEvent` cases in `EventTypes.swift`:
```swift
case scheduledJobCatchupRequested(jobId: String, jobName: String, lastRunAt: String?)
case scheduledJobFired(jobId: String, jobName: String, sessionId: String)
```

New notification category identifier: `"MISSED_JOB"`
Actions: `"RUN_NOW"` (Run) and `"SKIP"` (Skip)

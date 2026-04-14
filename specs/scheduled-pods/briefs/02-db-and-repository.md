# Brief 02: DB Migration + Repository

## Objective

Create migration `038_scheduled_jobs.sql`, implement `ScheduledJobRepository`, update
`SessionRepository` to accept and store `scheduled_job_id`, and expose a test helper
`insertTestScheduledJob()`.

## Dependencies

- Brief 01 (shared types) must be complete — repository methods return `ScheduledJob` types

## Blocked By

Brief 01.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/db/migrations/038_scheduled_jobs.sql` | create | New table + sessions column |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts` | create | New file |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.test.ts` | create | Unit tests |
| `packages/daemon/src/sessions/session-repository.ts` | modify | Accept + store `scheduled_job_id` |
| `packages/daemon/src/test-utils/mock-helpers.ts` | modify | Add `insertTestScheduledJob()` |

## Interface Contracts

Exposes `ScheduledJobRepository` interface and `createScheduledJobRepository()` factory
as defined in `contracts.md`.

## Implementation Notes

### Migration `038_scheduled_jobs.sql`

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

ALTER TABLE sessions ADD COLUMN scheduled_job_id TEXT REFERENCES scheduled_jobs(id);
CREATE INDEX idx_sessions_scheduled_job ON sessions(scheduled_job_id);
```

**Important:** The FK `last_session_id REFERENCES sessions(id)` is forward-declared.
SQLite does not enforce FK constraints unless `PRAGMA foreign_keys = ON` (which the
daemon enables). Make sure the sessions table exists before this migration runs — it
does, since `001_initial.sql` creates it. The migration runner applies files in
numeric prefix order.

Also note: `last_session_id` is on `scheduled_jobs` referencing `sessions`, AND
`scheduled_job_id` is on `sessions` referencing `scheduled_jobs`. This is a bidirectional
reference. SQLite allows this but it means deleting a job does NOT cascade-delete sessions
(we want that — sessions outlive their job).

### `scheduled-job-repository.ts`

Follow the pattern of `session-repository.ts` exactly:
- Factory function `createScheduledJobRepository(db: Database): ScheduledJobRepository`
- Use `better-sqlite3` synchronous API (`db.prepare(...).get(...)`, `.all(...)`, `.run(...)`)
- Map snake_case DB columns to camelCase TS fields in a private `mapRow()` helper
- `insert()` takes all fields except `createdAt`/`updatedAt` (DB defaults handle those)
- `update()` sets `updated_at = datetime('now')` on every call

Key query methods (beyond basic CRUD):
```typescript
listDue(): ScheduledJob[]
// SELECT * FROM scheduled_jobs
// WHERE enabled = 1 AND catchup_pending = 0 AND next_run_at <= datetime('now')

listOverdue(): ScheduledJob[]
// SELECT * FROM scheduled_jobs
// WHERE enabled = 1 AND catchup_pending = 0 AND next_run_at < datetime('now')

listPendingCatchup(): ScheduledJob[]
// SELECT * FROM scheduled_jobs WHERE catchup_pending = 1

countActiveSessionsForJob(jobId: string): number
// SELECT COUNT(*) FROM sessions
// WHERE scheduled_job_id = ? AND status NOT IN ('complete','failed','killed')
```

### `session-repository.ts` modifications

In the `insert()` method, add `scheduled_job_id` to the INSERT statement (nullable, defaults null).
In the `mapRow()` helper, map `row.scheduled_job_id` → `scheduledJobId`.
In the `SessionUpdate` type / update method, add `scheduledJobId?: string | null`.

Look at how `linked_session_id` was added (migration 022 + repository changes) as
the exact pattern to follow.

### `mock-helpers.ts`

Add:
```typescript
export function insertTestScheduledJob(
  db: Database,
  overrides: Partial<ScheduledJob> = {}
): ScheduledJob {
  // Sensible defaults: enabled=true, cron='0 9 * * 1', nextRunAt=future ISO string
  // Use scheduledJobRepo.insert()
}
```

### Tests (`scheduled-job-repository.test.ts`)

Use `createTestDb()` from `mock-helpers.ts` (it runs all migrations including 038).
Cover: insert, get, list, update, delete, `listDue` (with time manipulation), `listOverdue`,
`listPendingCatchup`, `countActiveSessionsForJob`.

For time-sensitive queries (`listDue`, `listOverdue`), insert rows with explicit
`next_run_at` values in the past/future and verify filtering is correct.

## Acceptance Criteria

- [ ] Migration `038_scheduled_jobs.sql` applies cleanly via `createTestDb()`
- [ ] All `ScheduledJobRepository` methods pass unit tests
- [ ] `sessions.scheduled_job_id` column exists and is returned in session row mapper
- [ ] `insertTestScheduledJob()` works in test helpers
- [ ] `npx pnpm --filter @autopod/daemon build` passes
- [ ] `npx pnpm --filter @autopod/daemon test` passes (all existing tests still green)

## Estimated Scope

Files: 5 | Complexity: medium

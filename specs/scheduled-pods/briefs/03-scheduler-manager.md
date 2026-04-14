# Brief 03: Scheduler + Manager

## Objective

Implement `ScheduledJobManager` (business logic: create/update/delete/catchup) and
`ScheduledJobScheduler` (in-process 60s polling loop + startup reconciler). Wire both
into `packages/daemon/src/index.ts`.

## Dependencies

- Brief 01 (shared types)
- Brief 02 (repository)

## Blocked By

Brief 02.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/scheduled-jobs/scheduled-job-manager.ts` | create | Business logic |
| `packages/daemon/src/scheduled-jobs/scheduled-job-manager.test.ts` | create | Unit tests |
| `packages/daemon/src/scheduled-jobs/scheduled-job-scheduler.ts` | create | Polling loop + reconciler |
| `packages/daemon/src/scheduled-jobs/scheduled-job-scheduler.test.ts` | create | Unit tests |
| `packages/daemon/src/index.ts` | modify | Wire up manager + scheduler |
| `packages/daemon/src/sessions/session-manager.ts` | modify | Pass `scheduledJobId` through `createSession` |
| `packages/daemon/package.json` | modify | Add `cron-parser` dependency |

## Interface Contracts

Exposes `ScheduledJobManager` interface as defined in `contracts.md`.

## Implementation Notes

### `cron-parser` dependency

Add `"cron-parser": "^4.9.0"` to `packages/daemon/package.json` dependencies.

Usage:
```typescript
import { parseExpression } from 'cron-parser'

// Validate
try {
  parseExpression(cronExpression)
} catch {
  throw new AutopodError('Invalid cron expression', 'INVALID_INPUT', 400)
}

// Compute next occurrence
function computeNextRunAt(cronExpression: string): string {
  const interval = parseExpression(cronExpression)
  return interval.next().toISOString()
}
```

Only allow standard 5-field cron (no seconds field). `cron-parser` accepts 5-field
expressions by default — no special config needed.

### `scheduled-job-manager.ts`

Factory: `createScheduledJobManager(deps): ScheduledJobManager`

Deps:
```typescript
interface ScheduledJobManagerDeps {
  scheduledJobRepo: ScheduledJobRepository
  sessionManager: SessionManager  // for createSession + active session check
  eventBus: EventBus
  logger: Logger
}
```

Key method implementations:

**`create(req)`:**
1. Validate `profileName` exists (call `profileStore.get()` or catch `ProfileNotFoundError`)

   Wait — `profileStore` is not in deps above. Add it, or just let `sessionManager.createSession()` throw on invalid profile at fire time. Prefer validating at create time: add `profileStore: ProfileStore` to deps.

2. Validate `cronExpression` via `parseExpression()`
3. Compute `nextRunAt = computeNextRunAt(req.cronExpression)`
4. Generate ID (use `nanoid` or existing `generateSessionId()` pattern — check how profiles generate IDs; actually scheduled jobs can use a UUID or a random ID)
5. Call `scheduledJobRepo.insert()`
6. Return created job

**`update(id, req)`:**
1. Load job (throws 404 if not found)
2. If `cronExpression` changed, validate + recompute `nextRunAt`
3. Call `scheduledJobRepo.update()`

**`runCatchup(id)`:**
1. Load job — throw 404 if not found
2. Throw 409 if `!job.catchupPending`
3. Check active sessions: `scheduledJobRepo.countActiveSessionsForJob(id)` → throw 400 if > 0
4. Call `sessionManager.createSession({ profileName: job.profileName, task: job.task, scheduledJobId: job.id }, SYSTEM_USER_ID)`
5. Update job: `catchup_pending = 0`, `last_run_at = now()`, `last_session_id = session.id`, `next_run_at = computeNextRunAt(...)`
6. Return session

**`skipCatchup(id)`:**
1. Load job — throw 404 if not found
2. Throw 409 if `!job.catchupPending`
3. Update job: `catchup_pending = 0`, `next_run_at = computeNextRunAt(...)`

**`reconcileMissedJobs()`:**
1. Call `scheduledJobRepo.listOverdue()`
2. For each: set `catchup_pending = 1`, emit `scheduled_job.catchup_requested` event
3. Log count of jobs marked for catch-up

**`tick()`:**
1. Call `scheduledJobRepo.listDue()`
2. For each job:
   a. Check `scheduledJobRepo.countActiveSessionsForJob(job.id)` → skip if > 0
   b. Create session: `sessionManager.createSession({ profileName, task, scheduledJobId: job.id }, SYSTEM_USER_ID)`
   c. Update job: `last_run_at`, `last_session_id`, `next_run_at`
   d. Emit `scheduled_job.fired` event
3. Catch errors per-job (log + continue — one bad job shouldn't stop others)

**`SYSTEM_USER_ID`:**
Sessions created by the scheduler need a `userId`. Use a sentinel:
`export const SCHEDULER_USER_ID = 'scheduler'`
This is fine since auth is dev-only in local mode. The `userId` is stored on sessions
but not used for access control in the current auth model.

### Skip-if-active: do NOT advance `nextRunAt`

When skipping a fire because an active session exists, **do not** update `nextRunAt`
on the job. Leave it as-is so the next tick picks it up again. The job will retry
every 60s until the active session reaches a terminal state.

### `scheduled-job-scheduler.ts`

```typescript
export function createScheduledJobScheduler(manager: ScheduledJobManager, logger: Logger) {
  let interval: ReturnType<typeof setInterval> | null = null

  function start(): void {
    manager.reconcileMissedJobs()  // synchronous, runs immediately on startup
    interval = setInterval(async () => {
      try {
        await manager.tick()
      } catch (err) {
        logger.error({ err }, 'scheduled job tick failed')
      }
    }, 60_000)
    interval.unref()  // don't block process exit
    logger.info('Scheduled job scheduler started')
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  return { start, stop }
}
```

### `index.ts` wiring

After creating `sessionManager` and before `app.listen()`:

```typescript
const scheduledJobRepo = createScheduledJobRepository(db)
const scheduledJobManager = createScheduledJobManager({
  scheduledJobRepo,
  sessionManager,
  profileStore,
  eventBus,
  logger,
})
const scheduledJobScheduler = createScheduledJobScheduler(scheduledJobManager, logger)

// Pass scheduledJobManager to server (for routes — see Brief 04)
const app = createServer({
  ...existingDeps,
  scheduledJobManager,
})

// Start scheduler AFTER server is listening
await app.listen(...)
scheduledJobScheduler.start()
```

Add `scheduledJobScheduler.stop()` to the `shutdown()` function before `db.close()`.

### `session-manager.ts` modifications

In `createSession(request, userId)`:
- Extract `scheduledJobId` from request (already added to type in Brief 01)
- Pass to `sessionRepo.insert({ ..., scheduledJobId: request.scheduledJobId ?? null })`

No other changes to `processSession()` — the `scheduledJobId` is just stored, not
used for any logic within session processing.

### Tests

**`scheduled-job-manager.test.ts`:**
- Use `createTestDb()` + `insertTestScheduledJob()` + mock `sessionManager` and `eventBus`
- Cover: `create` (valid + invalid cron + missing profile), `update` (cron recomputes nextRunAt),
  `runCatchup` (happy path, 409 if not pending, 400 if active session exists),
  `skipCatchup` (happy path, 409 if not pending), `reconcileMissedJobs` (emits events),
  `tick` (fires due jobs, skips active, handles per-job errors)

**`scheduled-job-scheduler.test.ts`:**
- Mock `manager.tick()` and `manager.reconcileMissedJobs()`
- Verify `start()` calls `reconcileMissedJobs()` immediately
- Verify `stop()` prevents further ticks

## Acceptance Criteria

- [ ] `scheduledJobManager.create()` rejects invalid cron expressions with a 400 error
- [ ] `reconcileMissedJobs()` marks overdue jobs `catchup_pending=true` and emits events
- [ ] `tick()` fires due jobs and skips jobs with active sessions
- [ ] `tick()` errors on one job do not prevent other jobs from firing
- [ ] `runCatchup()` creates a session and clears `catchup_pending`
- [ ] `skipCatchup()` clears `catchup_pending` and advances `next_run_at`
- [ ] Scheduler `start()` calls reconciler on startup
- [ ] Scheduler interval is `.unref()`'d
- [ ] All unit tests pass

## Estimated Scope

Files: 7 | Complexity: high

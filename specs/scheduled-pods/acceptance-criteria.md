ScheduledJob type is exported from @autopod/shared with id, name, profileName, task, cronExpression, enabled, nextRunAt, lastRunAt, lastSessionId, catchupPending fields
CreateScheduledJobRequest and UpdateScheduledJobRequest are exported from @autopod/shared
SystemEvent union includes ScheduledJobCatchupRequestedEvent with type scheduled_job.catchup_requested
SystemEvent union includes ScheduledJobFiredEvent with type scheduled_job.fired
CreateSessionRequest has optional scheduledJobId field
Migration 038_scheduled_jobs.sql creates the scheduled_jobs table and adds scheduled_job_id to sessions
sessions.scheduled_job_id is stored and returned in session objects
ScheduledJobRepository insert, get, list, update, delete methods all work correctly
ScheduledJobRepository listDue returns only enabled non-catchup-pending jobs with next_run_at in the past
ScheduledJobRepository listOverdue returns only enabled non-catchup-pending jobs with next_run_at in the past
ScheduledJobRepository countActiveSessionsForJob returns count of non-terminal sessions for the job
POST /scheduled-jobs returns 201 with created ScheduledJob
GET /scheduled-jobs returns array of all ScheduledJob objects
GET /scheduled-jobs/:id returns 404 for unknown job ID
PUT /scheduled-jobs/:id updates and returns the modified job
DELETE /scheduled-jobs/:id returns 204
POST /scheduled-jobs/:id/catchup returns 201 with a Session when catchupPending is true
POST /scheduled-jobs/:id/catchup returns 409 when catchupPending is false
POST /scheduled-jobs/:id/catchup returns 400 when a previous session from this job is still active
DELETE /scheduled-jobs/:id/catchup returns 204 and clears catchupPending when catchupPending is true
POST /scheduled-jobs/:id/trigger fires a session immediately regardless of schedule
Invalid cron expression in create or update returns 400
Scheduler tick fires due jobs and creates sessions with scheduledJobId set
Scheduler tick skips jobs with an active session and does not advance nextRunAt
Scheduler tick errors on one job do not prevent other jobs from firing
Scheduler tick does not fire jobs where catchupPending is true
reconcileMissedJobs marks overdue jobs catchupPending true and emits scheduled_job.catchup_requested
reconcileMissedJobs is called on daemon startup before the tick interval starts
Scheduler setInterval is unref'd so it does not block process exit
runCatchup sets catchupPending to false and advances nextRunAt after creating a session
skipCatchup sets catchupPending to false and advances nextRunAt without creating a session
nextRunAt after any fire is computed from the cron expression relative to now, not the missed fire time
Sessions created by the scheduler have scheduledJobId set to the job ID
ap schedule create creates a job and prints the next run time
ap schedule list shows all jobs in a table with a status column
ap schedule list --json outputs raw JSON
ap schedule enable and ap schedule disable toggle the enabled field
ap schedule run fires a session immediately and prints the session ID
ap schedule delete removes the job
ap schedule catchup lists pending jobs and prompts run or skip for each
ap schedule catchup prints No jobs need catch-up when none are pending
Desktop app ScheduledJob Swift struct matches the TypeScript interface field for field
Desktop EventTypes.swift handles scheduled_job.catchup_requested and scheduled_job.fired
Desktop receives scheduled_job.catchup_requested and fires a macOS notification with Run Now and Skip actions
Clicking Run Now in the macOS notification calls POST /scheduled-jobs/:id/catchup
Clicking Skip in the macOS notification calls DELETE /scheduled-jobs/:id/catchup
Desktop shows a Scheduled Jobs section listing all jobs
Jobs with catchupPending true are visually distinct in the desktop UI
Desktop ScheduledJobFiredEvent handler refreshes the job row and the spawned session

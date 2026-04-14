# Brief 05: CLI + Client

## Objective

Add `ap schedule` subcommands to the CLI and the corresponding methods to `AutopodClient`.

## Dependencies

- Brief 01 (shared types — `ScheduledJob` imported by client)
- Brief 04 (API routes must exist for integration testing)

## Blocked By

Brief 04.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/cli/src/api/client.ts` | modify | Add 8 new scheduled job methods |
| `packages/cli/src/commands/schedule.ts` | create | `registerScheduleCommands()` |
| `packages/cli/src/index.ts` | modify | Register schedule commands |

## Interface Contracts

Consumes REST API defined in Brief 04. Exposes `ap schedule` subcommands.

## Implementation Notes

### `client.ts` additions

Add after the sessions block:

```typescript
// Scheduled Jobs
async createScheduledJob(req: CreateScheduledJobRequest): Promise<ScheduledJob> {
  return this.request<ScheduledJob>('POST', '/scheduled-jobs', req)
}

async listScheduledJobs(): Promise<ScheduledJob[]> {
  return this.request<ScheduledJob[]>('GET', '/scheduled-jobs')
}

async getScheduledJob(id: string): Promise<ScheduledJob> {
  return this.request<ScheduledJob>('GET', `/scheduled-jobs/${id}`)
}

async updateScheduledJob(id: string, req: UpdateScheduledJobRequest): Promise<ScheduledJob> {
  return this.request<ScheduledJob>('PUT', `/scheduled-jobs/${id}`, req)
}

async deleteScheduledJob(id: string): Promise<void> {
  await this.request<void>('DELETE', `/scheduled-jobs/${id}`)
}

async runScheduledJobCatchup(id: string): Promise<Session> {
  return this.request<Session>('POST', `/scheduled-jobs/${id}/catchup`)
}

async skipScheduledJobCatchup(id: string): Promise<void> {
  await this.request<void>('DELETE', `/scheduled-jobs/${id}/catchup`)
}

async triggerScheduledJob(id: string): Promise<Session> {
  return this.request<Session>('POST', `/scheduled-jobs/${id}/trigger`)
}
```

Import `ScheduledJob`, `CreateScheduledJobRequest`, `UpdateScheduledJobRequest`
from `@autopod/shared`.

### `commands/schedule.ts`

```typescript
export function registerScheduleCommands(program: Command, getClient: () => AutopodClient): void
```

**Subcommands:**

**`ap schedule create <profile> <name> <cron> <task>`**
```
ap schedule create my-profile "Daily vuln scan" "0 9 * * *" "Run npm audit and fix all critical vulnerabilities"
```
- Creates job, prints: `Schedule abc12345 created. Next run: <human-readable next_run_at>`
- Format `nextRunAt` as a human-readable string (e.g., "tomorrow at 9:00am")

**`ap schedule list`**
Table output with columns: `ID`, `NAME`, `PROFILE`, `CRON`, `ENABLED`, `NEXT RUN`, `STATUS`
- STATUS is `active` / `disabled` / `catchup pending`
- Use `chalk` for colors — orange for `catchup pending`, dim for `disabled`
- `--json` flag for machine-readable output

**`ap schedule show <id>`**
- Full job details
- Show last session ID (if set) as a link: "Last session: abc12345 (complete)"

**`ap schedule enable <id>` / `ap schedule disable <id>`**
- Calls `updateScheduledJob(id, { enabled: true/false })`
- Print confirmation

**`ap schedule delete <id>`**
- Calls `deleteScheduledJob(id)`
- Print "Schedule deleted."

**`ap schedule run <id>`**
- Calls `triggerScheduledJob(id)` — fires immediately, ignores schedule
- Print: `Session <id> started.` and hint: `ap session show <sessionId>`

**`ap schedule catchup`**
- Fetches all jobs where `catchupPending = true`
- If none: print "No jobs need catch-up."
- For each: interactive prompt (use `inquirer` or the existing `readline` approach in the codebase):
  ```
  Job "Daily vuln scan" was last run 3 days ago. Run now? [y/N]
  ```
  - y → `runScheduledJobCatchup(id)` → print session ID
  - N → `skipScheduledJobCatchup(id)` → print "Skipped."

Check how existing interactive prompts work in the CLI before implementing — search for
`readline` or `prompt` usage in the commands. Follow that pattern exactly.

### `index.ts`

Add:
```typescript
import { registerScheduleCommands } from './commands/schedule.js'
// ... after existing registerWorkspaceCommands call:
registerScheduleCommands(program, getClient)
```

### Output formatting for `ap schedule list`

Follow the table pattern from `ap session list` in `session.ts`. The `listSessions`
command renders a chalk-formatted table — use the same structure for `listScheduledJobs`.

## Acceptance Criteria

- [ ] `ap schedule create` creates a job and displays next run time
- [ ] `ap schedule list` shows all jobs in a table with status column
- [ ] `ap schedule list --json` outputs raw JSON
- [ ] `ap schedule enable/disable` toggles the job
- [ ] `ap schedule run <id>` fires a session immediately
- [ ] `ap schedule catchup` prompts for each pending job and acts on response
- [ ] `ap schedule delete <id>` deletes the job
- [ ] `npx pnpm --filter @autopod/cli build` passes

## Estimated Scope

Files: 3 | Complexity: medium

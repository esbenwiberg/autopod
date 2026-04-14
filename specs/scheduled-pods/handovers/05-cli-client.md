# Handover: Brief 05 — CLI + Client

## Status: Complete

## What Was Done

- Updated `packages/cli/src/api/client.ts` to add 8 scheduled job methods: `createScheduledJob`, `listScheduledJobs`, `getScheduledJob`, `updateScheduledJob`, `deleteScheduledJob`, `runScheduledJobCatchup`, `skipScheduledJobCatchup`, `triggerScheduledJob`
- Created `packages/cli/src/commands/schedule.ts` with `registerScheduleCommands()` implementing:
  - `ap schedule create <profile> <name> <cron> <task>`
  - `ap schedule list` (with `--json` flag)
  - `ap schedule show <id>`
  - `ap schedule enable <id>` / `ap schedule disable <id>`
  - `ap schedule delete <id>`
  - `ap schedule run <id>`
  - `ap schedule catchup` (interactive: prompts run/skip for each pending job)
- Updated `packages/cli/src/index.ts` to register the new commands

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/api/client.ts` | Added 8 scheduled job methods |
| `packages/cli/src/commands/schedule.ts` | Created — all ap schedule subcommands |
| `packages/cli/src/index.ts` | Registered schedule commands |

## Acceptance Criteria Met

- [x] `ap schedule create` creates a job and displays next run time
- [x] `ap schedule list` shows all jobs in a table with status column
- [x] `ap schedule list --json` outputs raw JSON
- [x] `ap schedule enable/disable` toggles the job
- [x] `ap schedule run <id>` fires a session immediately
- [x] `ap schedule catchup` prompts for each pending job
- [x] `ap schedule delete <id>` deletes the job
- [x] All 65 CLI tests pass, build passes

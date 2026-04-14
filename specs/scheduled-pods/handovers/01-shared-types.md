# Handover: Brief 01 — Shared Types

## Status: Complete

## What Was Done

- Created `packages/shared/src/types/scheduled-job.ts` with `ScheduledJob`, `CreateScheduledJobRequest`, `UpdateScheduledJobRequest` interfaces
- Extended `packages/shared/src/types/events.ts` with `ScheduledJobCatchupRequestedEvent` and `ScheduledJobFiredEvent` interfaces, added both to the `SystemEvent` union
- Extended `packages/shared/src/types/session.ts`: added `scheduledJobId: string | null` to `Session` and `scheduledJobId?: string | null` to `CreateSessionRequest`
- Updated `packages/shared/src/index.ts` to re-export all new types

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types/scheduled-job.ts` | Created — 3 interfaces |
| `packages/shared/src/types/events.ts` | Added 2 event interfaces + 2 union members |
| `packages/shared/src/types/session.ts` | Added `scheduledJobId` to `Session` and `CreateSessionRequest` |
| `packages/shared/src/index.ts` | Added re-exports for new events + scheduled-job types |

## Acceptance Criteria Met

- [x] `ScheduledJob`, `CreateScheduledJobRequest`, `UpdateScheduledJobRequest` exported from `@autopod/shared`
- [x] `SystemEvent` union includes `ScheduledJobCatchupRequestedEvent` and `ScheduledJobFiredEvent`
- [x] `CreateSessionRequest` has optional `scheduledJobId` field
- [x] `Session` has `scheduledJobId: string | null` field
- [x] `npx pnpm --filter @autopod/shared build` passes

## Notes for Brief 02

The `session-repository.ts` `rowToSession()` mapper will need to map `row.scheduled_job_id` → `scheduledJobId`. The `NewSession` insert type and the `insert()` SQL also need to include `scheduled_job_id`. Brief 02 owns those changes.

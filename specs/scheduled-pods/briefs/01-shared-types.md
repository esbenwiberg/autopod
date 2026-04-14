# Brief 01: Shared Types

## Objective

Add `ScheduledJob` types, `CreateScheduledJobRequest`, `UpdateScheduledJobRequest`,
two new `SystemEvent` types, and a `scheduledJobId` field on `CreateSessionRequest`
to `packages/shared`. Everything downstream depends on these.

## Dependencies

None. This is the root of the dependency graph.

## Blocked By

Nothing.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/scheduled-job.ts` | create | New file — full type definitions |
| `packages/shared/src/types/events.ts` | modify | Add 2 new event interfaces + union members |
| `packages/shared/src/types/session.ts` | modify | Add `scheduledJobId?: string \| null` to `CreateSessionRequest` |
| `packages/shared/src/index.ts` | modify | Re-export new types from `scheduled-job.ts` |

## Interface Contracts

Exposes all types defined in `contracts.md` under "Shared Types" and "Updated Shared Types".

## Implementation Notes

### `scheduled-job.ts`

Create with exactly the shapes in `contracts.md`. Use `export interface` (not `export type`).

### `events.ts`

Existing pattern to follow — look at `TokenBudgetWarningEvent` as the model:
```typescript
export interface ScheduledJobCatchupRequestedEvent {
  type: 'scheduled_job.catchup_requested'
  timestamp: string
  jobId: string
  jobName: string
  lastRunAt: string | null
}

export interface ScheduledJobFiredEvent {
  type: 'scheduled_job.fired'
  timestamp: string
  jobId: string
  jobName: string
  sessionId: string
}
```

Add both to the `SystemEvent` union.

### `session.ts`

Add to `CreateSessionRequest` (optional, internal — not exposed to CLI users):
```typescript
scheduledJobId?: string | null
```

### `index.ts`

Add re-export:
```typescript
export type {
  ScheduledJob,
  CreateScheduledJobRequest,
  UpdateScheduledJobRequest,
} from './types/scheduled-job.js'
```

Follow the existing `export type` pattern for type-only exports.

## Acceptance Criteria

- [ ] `ScheduledJob`, `CreateScheduledJobRequest`, `UpdateScheduledJobRequest` are exported from `@autopod/shared`
- [ ] `SystemEvent` union includes `ScheduledJobCatchupRequestedEvent` and `ScheduledJobFiredEvent`
- [ ] `CreateSessionRequest` has optional `scheduledJobId` field
- [ ] `npx pnpm --filter @autopod/shared build` passes with no TypeScript errors
- [ ] `npx pnpm --filter @autopod/shared lint` passes

## Estimated Scope

Files: 4 | Complexity: low

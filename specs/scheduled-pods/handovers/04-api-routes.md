# Handover: Brief 04 — API Routes

## Status: Complete

## What Was Done

- Created `packages/daemon/src/api/routes/scheduled-jobs.ts` with 8 route handlers:
  - `POST /scheduled-jobs` (201)
  - `GET /scheduled-jobs` (200)
  - `GET /scheduled-jobs/:id` (200)
  - `PUT /scheduled-jobs/:id` (200)
  - `DELETE /scheduled-jobs/:id` (204)
  - `POST /scheduled-jobs/:id/catchup` (201 / 409 / 400)
  - `DELETE /scheduled-jobs/:id/catchup` (204)
  - `POST /scheduled-jobs/:id/trigger` (201)
- Updated `packages/daemon/src/api/server.ts` to register routes when `scheduledJobManager` is present
- Created `packages/daemon/src/api/routes/scheduled-jobs.test.ts` with 11 tests — all pass

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/src/api/routes/scheduled-jobs.ts` | Created — 8 route handlers |
| `packages/daemon/src/api/routes/scheduled-jobs.test.ts` | Created — 11 tests |
| `packages/daemon/src/api/server.ts` | Added `scheduledJobRoutes` registration |

## Key Design Notes

- Route tests use a bare `Fastify()` instance with just the error handler and routes registered — this avoids the pre-existing `@autopod/escalation-mcp` resolution issue that affects tests importing `createServer`
- Error handling delegated to the existing `errorHandler` — `AutopodError` instances map directly to their `statusCode`

## Acceptance Criteria Met

- [x] `POST /scheduled-jobs` returns 201
- [x] `GET /scheduled-jobs` returns array
- [x] `GET /scheduled-jobs/:id` returns 404 for unknown
- [x] `DELETE /scheduled-jobs/:id` returns 204
- [x] `POST /scheduled-jobs/:id/catchup` returns 201 / 409 / 400
- [x] `DELETE /scheduled-jobs/:id/catchup` returns 204
- [x] `POST /scheduled-jobs/:id/trigger` returns 201
- [x] 1100 total tests pass

## Notes for Brief 05

Brief 05 adds `ap schedule` CLI commands. The client methods in `packages/cli/src/api/client.ts` should match these endpoints. The `Session` type (returned by catchup and trigger) needs `scheduledJobId` in the mapped output — that was added in Brief 02's session-repository changes.

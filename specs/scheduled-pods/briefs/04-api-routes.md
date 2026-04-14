# Brief 04: API Routes

## Objective

Expose the `ScheduledJobManager` via REST: full CRUD plus `POST/DELETE /catchup`.
Register routes in `server.ts` and pass `scheduledJobManager` through `ServerDependencies`.

## Dependencies

- Brief 03 (manager must exist before routes can use it)

## Blocked By

Brief 03.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/api/routes/scheduled-jobs.ts` | create | Route handler |
| `packages/daemon/src/api/routes/scheduled-jobs.test.ts` | create | Route tests via `app.inject()` |
| `packages/daemon/src/api/server.ts` | modify | Add to `ServerDependencies` + register routes |

## Interface Contracts

Exposes REST endpoints as defined in `contracts.md` under "REST API".

## Implementation Notes

### `routes/scheduled-jobs.ts`

Follow the exact pattern of `routes/profiles.ts`:

```typescript
export function scheduledJobRoutes(
  app: FastifyInstance,
  scheduledJobManager: ScheduledJobManager,
): void {
  // POST /scheduled-jobs
  app.post('/scheduled-jobs', async (request, reply) => {
    const job = scheduledJobManager.create(request.body as CreateScheduledJobRequest)
    reply.status(201)
    return job
  })

  // GET /scheduled-jobs
  app.get('/scheduled-jobs', async () => {
    return scheduledJobManager.list()
  })

  // GET /scheduled-jobs/:id
  app.get('/scheduled-jobs/:id', async (request) => {
    const { id } = request.params as { id: string }
    return scheduledJobManager.get(id)
  })

  // PUT /scheduled-jobs/:id
  app.put('/scheduled-jobs/:id', async (request) => {
    const { id } = request.params as { id: string }
    return scheduledJobManager.update(id, request.body as UpdateScheduledJobRequest)
  })

  // DELETE /scheduled-jobs/:id
  app.delete('/scheduled-jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    scheduledJobManager.delete(id)
    reply.status(204)
  })

  // POST /scheduled-jobs/:id/catchup — run missed job now
  app.post('/scheduled-jobs/:id/catchup', async (request, reply) => {
    const { id } = request.params as { id: string }
    const session = await scheduledJobManager.runCatchup(id)
    reply.status(201)
    return session
  })

  // DELETE /scheduled-jobs/:id/catchup — skip missed job
  app.delete('/scheduled-jobs/:id/catchup', async (request, reply) => {
    const { id } = request.params as { id: string }
    scheduledJobManager.skipCatchup(id)
    reply.status(204)
  })
}
```

Error handling is done by the global `errorHandler` in `server.ts` — `AutopodError`
thrown by the manager will be caught and serialized automatically. No try/catch needed
in route handlers.

### `server.ts` modifications

1. Add to `ServerDependencies` interface:
   ```typescript
   scheduledJobManager?: ScheduledJobManager
   ```

2. Register routes (after `profileRoutes`, before `memoryRoutes`):
   ```typescript
   if (deps.scheduledJobManager) {
     scheduledJobRoutes(app, deps.scheduledJobManager)
   }
   ```

3. Add import for `scheduledJobRoutes` and `ScheduledJobManager`.

### `AutopodClient` (CLI client — owned by Brief 05 but API contract defined here)

The client methods to add:
```typescript
// In packages/cli/src/api/client.ts
async createScheduledJob(req: CreateScheduledJobRequest): Promise<ScheduledJob>
async listScheduledJobs(): Promise<ScheduledJob[]>
async getScheduledJob(id: string): Promise<ScheduledJob>
async updateScheduledJob(id: string, req: UpdateScheduledJobRequest): Promise<ScheduledJob>
async deleteScheduledJob(id: string): Promise<void>
async runScheduledJobCatchup(id: string): Promise<Session>
async skipScheduledJobCatchup(id: string): Promise<void>
async triggerScheduledJob(id: string): Promise<Session>  // for `ap schedule run`
```

Wait — `ap schedule run` (manual trigger) isn't the same as catchup. It needs a
separate endpoint or we reuse POST /scheduled-jobs/:id/catchup with a `?force=true` param.

**Decision:** Add `POST /scheduled-jobs/:id/trigger` — fires a session immediately,
ignoring schedule and `catchup_pending` state, but still respects skip-if-active.
This is for `ap schedule run <id>` (manual one-off trigger).

Add to route file:
```typescript
app.post('/scheduled-jobs/:id/trigger', async (request, reply) => {
  const { id } = request.params as { id: string }
  const session = await scheduledJobManager.trigger(id)
  reply.status(201)
  return session
})
```

Add `trigger(id: string): Promise<Session>` to `ScheduledJobManager` interface and
implement in Brief 03 (same logic as `tick()` for a single job — Brief 03 owns
`scheduled-job-manager.ts`).

### Route tests (`scheduled-jobs.test.ts`)

Use `app.inject()` pattern from `packages/daemon/src/integration.test.ts`.
Mock `scheduledJobManager` with vitest mocks.
Cover each endpoint: happy path, 404 for unknown ID, 409/400 for catchup error states.

## Acceptance Criteria

- [ ] `POST /scheduled-jobs` creates a job and returns 201
- [ ] `GET /scheduled-jobs` returns array
- [ ] `GET /scheduled-jobs/:id` returns 404 for unknown ID
- [ ] `DELETE /scheduled-jobs/:id` returns 204
- [ ] `POST /scheduled-jobs/:id/catchup` returns 201 with a Session body
- [ ] `DELETE /scheduled-jobs/:id/catchup` returns 204
- [ ] `POST /scheduled-jobs/:id/catchup` returns 409 if `catchupPending = false`
- [ ] `POST /scheduled-jobs/:id/trigger` fires a session immediately
- [ ] Routes are protected by auth middleware (401 in prod mode without token)
- [ ] Route unit tests pass

## Estimated Scope

Files: 3 | Complexity: low

---
title: "Expose screenshots over the daemon HTTP API"
depends_on: [ 01-add-screenshot-store ]
acceptance_criteria:
  - type: cmd
    outcome: test -f packages/daemon/src/api/routes/screenshots.ts → exit 0
    hint: test -f packages/daemon/src/api/routes/screenshots.ts
    polarity: exit-zero
  - type: cmd
    outcome: "! grep -nE 'screenshotBase64|\\\"screenshot\\\":\\\\s*\\\"data:image' packages/daemon/src/api/routes/pods.ts → exit 0 — the pods route no longer emits base64 screenshot fields"
    hint: "! grep -nE 'screenshotBase64|\\\"screenshot\\\":\\\\s*\\\"data:image' packages/daemon/src/api/routes/pods.ts"
    polarity: exit-zero
  - type: api
    outcome: GET /pods/:podId/screenshots/smoke/<filename>.png against a pod whose screenshot was just written by the store → 200 with content-type image/png and the body byte-length > 0
    hint: GET /pods/:podId/screenshots/smoke/<filename>.png against a pod whose screenshot was just written by the store
  - type: api
    outcome: GET /pods/:podId/validations against a pod with screenshots → 200 with body whose validation-history entries carry `screenshot` / `screenshots` fields shaped { url, source, path } (no base64 strings anywhere)
    hint: GET /pods/:podId/validations against a pod with screenshots
touches:
  - packages/daemon/src/api/routes/screenshots.ts
  - packages/daemon/src/api/routes/screenshots.test.ts
  - packages/daemon/src/api/server.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/notifications/notification-service.ts
  - packages/daemon/src/validation/report-generator.ts
does_not_touch:
  - packages/daemon/src/pods/screenshot-store.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/worktrees/
  - packages/desktop/
---

## Task

Surface screenshots over HTTP for the desktop, change the JSON
serialiser shape on `/pods` / validation endpoints to return
`ScreenshotRefDto` instead of base64, and rewire the two daemon-
internal consumers that still need raw base64 (Teams notifications,
HTML report) to read PNGs from disk and base64-encode at the moment
they need it.

### New route — `GET /pods/:podId/screenshots/:source/:filename`

Create `packages/daemon/src/api/routes/screenshots.ts`. Register it
in `packages/daemon/src/api/server.ts` adjacent to the existing
`/pods` and `/files` route registrations.

Handler responsibilities:

- Validate `:source` ∈ `{ smoke, ac, review }`. 400 on anything else.
- Validate `:filename` matches `^[A-Za-z0-9._-]+\.png$`. 400 on
  anything else (defence-in-depth — the store also rejects, but the
  route should never construct a path that the store can't handle).
- Build a `ScreenshotRef` from the URL params and call
  `screenshotStore.read(ref)`.
- 404 when the file doesn't exist (`ENOENT` from the store).
- 200 with `Content-Type: image/png` and the raw bytes.
- Set `Cache-Control: private, max-age=31536000, immutable`. The
  per-pod path is content-addressed by pod identity; once written,
  bytes are stable until pod retention deletes the directory. The
  desktop benefits from cacheable thumbnails.

Auth: register the route behind the same auth plugin as
`packages/daemon/src/api/routes/files.ts`. Files is the precedent —
match it. Both user tokens (desktop) and pod tokens are accepted by
the existing plugin.

`screenshots.test.ts`:
- 200 round-trip after a `screenshotStore.write` of a small PNG
  buffer.
- 404 when the file doesn't exist.
- 400 on bad source / filename.
- 401/403 (whatever the auth plugin returns) when called without a
  token in `NODE_ENV=production`.
- `Content-Type` is `image/png` and `Content-Length` matches.

### Pods route serialiser

`packages/daemon/src/api/routes/pods.ts` returns pod detail and
validation history. Today the response embeds base64 strings under
`result.smoke.pages[].screenshotBase64`,
`result.acValidation.checks[].screenshot`, and
`result.taskReview.screenshots[]`. After brief 01, the stored result
shape uses `ScreenshotRef`. This brief converts those refs to
`ScreenshotRefDto` on the way out:

```ts
interface ScreenshotRefDto {
  url: string;       // "/pods/:podId/screenshots/:source/:filename"
  source: 'smoke' | 'ac' | 'review';
  path: string;      // smoke: page path; ac: criterion text; review: index as string
}
```

Build a small helper (e.g. `toScreenshotRefDto(ref, contextPath)`)
in this file or a sibling util. The `path` field carries the
caller's context label, NOT the on-disk relative path. For:
- `smoke` — the smoke page URL path (e.g. `/`, `/about`)
- `ac` — the criterion text the screenshot was taken for
- `review` — the screenshot's array index as a string

Do not include `relativePath` or `filename` in the DTO. The desktop
reads PNGs by `url`, period.

The same serialiser is used by every endpoint that emits validation
data — search `pods.ts` for `result.smoke`, `result.acValidation`,
`result.taskReview` reads and rewire each.

### Notifications

`packages/daemon/src/notifications/notification-service.ts` builds
Teams adaptive cards that carry inline base64 PNGs (Teams renders
`data:image/png;base64,...`). After brief 01, the validation row
no longer carries base64 — it carries `ScreenshotRef`s. Rewire:

```ts
const buf = await screenshotStore.read(ref);
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
```

…and embed the `dataUrl` exactly where today's code embeds the
already-base64 string. The wire shape going to Teams is unchanged
(`purpose.md` → Users: "Teams card recipients … keep receiving
inline base64 images").

If a screenshot read fails (ENOENT — the file was retention-pruned),
omit that screenshot from the card and log a warning. Do NOT fail
the whole notification.

### HTML report generator

`packages/daemon/src/validation/report-generator.ts` renders an HTML
report that embeds `<img src="data:image/png;base64,...">`. Same
treatment as notifications: read from disk via `ScreenshotStore`,
base64-encode at render time, embed the `data:` URL into the
`<img>`. Same fail-soft on missing file (skip the image, log).

### `screenshotStore` injection

The store is constructed in `index.ts` (brief 01) and held by
`PodManager`. The new route handler needs access; pass it through
the API server's `app.decorate` (matching how the existing routes
get their repositories), or attach the same store instance to the
Fastify app context. Notifications and the report generator
already take constructor-injected dependencies — add `screenshotStore`
to those constructors and wire from `index.ts`.

## Touches

- `packages/daemon/src/api/routes/screenshots.ts` *(new)* — the
  HTTP route.
- `packages/daemon/src/api/routes/screenshots.test.ts` *(new)* —
  route tests via `app.inject()`.
- `packages/daemon/src/api/server.ts` — register the route + thread
  `screenshotStore` to it.
- `packages/daemon/src/api/routes/pods.ts` — convert
  `ScreenshotRef` → `ScreenshotRefDto` in every response that emits
  validation data.
- `packages/daemon/src/notifications/notification-service.ts` —
  read-from-disk, base64-encode at notify time.
- `packages/daemon/src/validation/report-generator.ts` — same, at
  render time.

## Does not touch

- `packages/daemon/src/pods/screenshot-store.ts` — brief 01 owns
  the store.
- `packages/daemon/src/db/migrations/` — schema is set in brief 01.
- `packages/daemon/src/pods/pod-manager.ts` — writer site is brief
  01; retention hook is brief 02-prune.
- `packages/daemon/src/worktrees/` — brief 02-ado.
- `packages/desktop/` — brief 03.

## Constraints

From `design.md` → Contracts: `GET /pods/:podId/screenshots/:source/
:filename` is frozen — desktop (brief 03) hard-codes this path. Do
not parametrise the URL shape.

From `design.md` → Contracts: `ScreenshotRefDto` shape is frozen.
Desktop decodes by these field names.

From `purpose.md` → Non-goals: the screenshot endpoint stays
loopback-only. Do not add CORS / public-host config — the existing
auth plugin and bind address (`HOST=0.0.0.0` by default but
typically `127.0.0.1` in dev) are sufficient.

From `daemon/CLAUDE.md` → "API Server": auth is stubbed in dev. Do
not bypass the auth plugin in dev mode — let the plugin handle the
mode check.

## Test expectations

`screenshots.test.ts`:
- Write a 4×4 PNG to the store (use `screenshotStore.write` directly
  in the test setup), then `app.inject` the GET. Assert 200,
  `image/png`, and that the response payload buffer matches the
  written bytes.
- 404 round-trip for a non-existent filename.
- 400 for `:source` not in the allowed set.
- 400 for filenames containing `..` or `/`.
- Production auth path: spin up the app with `NODE_ENV=production`
  and confirm the route requires a bearer token.

`pods.test.ts` (existing tests need updating):
- Seed a pod with a validation row whose `result.smoke.pages` has
  one entry with `screenshot: <ScreenshotRef>`. Hit the pod-detail
  endpoint. Assert the response carries `screenshot: { url, source,
  path }` with `url` matching `/pods/:id/screenshots/smoke/...` and
  no `screenshotBase64` field anywhere in the JSON.
- Same for `acValidation.checks[].screenshot` and
  `taskReview.screenshots[]`.

`notification-service.test.ts`:
- Seed a `ScreenshotRef`, mock the store's `read` to return a known
  buffer, and assert the outgoing webhook payload carries
  `data:image/png;base64,<expected>`.
- Mock `read` to throw `ENOENT`; assert the notification still
  fires, the screenshot is omitted from the card, and a warning is
  logged.

`report-generator.test.ts` (if it exists; create one if not):
- Same shape as notifications — fail-soft on missing files.

## Risks / pitfalls

- **Route ordering / param collision.** `/pods/:podId/...` is a
  busy prefix in `pods.ts`. Adding the new route in a separate
  module avoids the collision — register it AFTER `pods.ts` so
  Fastify's stricter matchers win, or register at a more-specific
  path that won't shadow other `/pods/:podId/<verb>` endpoints. If
  in doubt, hit `app.printRoutes()` in the test to confirm.

- **DTO is not the storage shape.** Don't accidentally serialise
  `ScreenshotRef` (which has `podId`, `filename`, `relativePath`)
  to the wire — the desktop expects `ScreenshotRefDto` (`url`,
  `source`, `path`). `podId` leaks the URL anyway, but
  `relativePath` is internal.

- **Cache-Control on auth'd routes.** `private, max-age=31536000,
  immutable` is fine because the auth plugin already gates access.
  Don't switch to `public`.

- **Notification fail-soft semantics.** If a notification arrives
  for a freshly-completed pod and a screenshot is missing (it
  shouldn't be — retention runs only on terminal-state pods past
  the retention period — but defence in depth), the notification
  must still go out. The user sees the card without an image, not
  a missing notification.

- **Report generator concurrency.** If the report is generated in a
  hot loop, base64-encoding 5+ PNGs every render adds latency.
  Confirm the report generator is called once per validation
  attempt (it is, today) — no caching needed.

- **Auth plugin in tests.** `app.inject()` tests run against the
  real auth plugin. In `NODE_ENV !== 'production'` it accepts all
  tokens; the test framework spins up that mode by default. For the
  production-mode test, set `NODE_ENV=production` for that single
  test only — restore it in the teardown.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm --filter @autopod/daemon test` — passes.
3. `npx pnpm build` — passes.
4. Manual smoke: pod completes, hit
   `GET /pods/<id>/screenshots/smoke/root.png` — see the PNG.
5. Manual smoke: trigger a Teams notification with a screenshot —
   confirm the card renders the image.
6. Commit and push.

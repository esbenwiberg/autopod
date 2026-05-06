# Design — Proof-of-Work Screenshots

## Blast radius

### Daemon (`packages/daemon`)

- `src/db/migrations/091_drop_screenshot_blobs.sql` *(new)* — drops the
  `validations.screenshots` column; rewrites `validations.result` JSON to strip
  `screenshotBase64` (smoke pages), `screenshot` (AC checks), and
  `screenshots[]` (task review) fields. Atomic; runs after a pre-migration DB
  snapshot.
- `src/pods/screenshot-store.ts` *(new)* — disk read/write API. Owns the
  `<dataDir>/screenshots/<podId>/<source>/<filename>.png` layout.
- `src/pods/screenshot-retention.ts` *(new)* — sweeper that deletes
  per-pod screenshot dirs older than `AUTOPOD_SCREENSHOT_RETENTION_DAYS` for
  pods in terminal states.
- `src/pods/validation-repository.ts` — stops writing base64 into the
  `screenshots` column. Either drops the field on insert or writes an empty
  array (column will be nulled then dropped by migration).
- `src/pods/pod-manager.ts` — replaces the `page.screenshotBase64 = ss.base64`
  assignment (line 6345) with a write through `ScreenshotStore`. Provider-aware
  `screenshotRefs` construction for ADO vs GitHub. Wires the retention sweeper
  start/stop into the daemon lifecycle.
- `src/validation/screenshot-collector.ts` — reads PNGs from worktree, writes
  to `ScreenshotStore`, returns `{ source, filename, relativePath }` instead
  of base64. Adds `buildAdoAttachmentRef()` (or equivalent) alongside the
  existing `buildGitHubImageUrl`.
- `src/validation/local-validation-engine.ts` — AC check screenshots routed
  through `ScreenshotStore` instead of base64-in-result.
- `src/api/routes/screenshots.ts` *(new)* — `GET /pods/:podId/screenshots/:
  source/:filename` returns `image/png` from disk, gated by the existing auth
  plugin.
- `src/api/routes/pods.ts` — pod / validation-history serialisers return
  `{ url, source, path }[]` instead of base64 arrays.
- `src/api/server.ts` — registers the new route.
- `src/notifications/notification-service.ts` — Teams cards still receive
  base64; the service reads PNGs from disk via `ScreenshotStore` and
  base64-encodes at notification time.
- `src/validation/report-generator.ts` — HTML report still embeds inline
  `<img src="data:image/png;base64,...">`; reads from disk and encodes at
  render time.
- `src/worktrees/ado-pr-manager.ts` — uploads screenshots as PR attachments
  via the ADO REST API and uses the returned attachment URLs in PR-body
  rendering. Falls back gracefully if the upload fails.
- `src/index.ts` — reads `AUTOPOD_SCREENSHOT_RETENTION_DAYS`; starts the
  retention sweeper on boot.

### Escalation MCP (`packages/escalation-mcp`)

- `src/tools/validate-in-browser.ts` — instead of returning base64 inline in
  the tool response, hands the bytes to the daemon (via the existing
  `PodBridge`) for storage and returns a path token. The agent never reads
  the screenshot field, only `passed` / `reasoning`, so this is an internal
  rewire.

### Shared types (`packages/shared`)

- `src/types/validation.ts` — `PageResult.screenshotBase64`,
  `AcCheckResult.screenshot`, `TaskReviewResult.screenshots[]` all change from
  base64 strings to either a `ScreenshotRef` shape (`{ url, source, path }`)
  or are removed entirely with screenshot info living on a sibling field.
  Decision: introduce a new `ScreenshotRef` interface and replace the base64
  fields. Old `screenshotBase64` field name is removed (drop-on-cutover means
  no backwards compat is needed).

### Desktop (`packages/desktop`)

- `Sources/AutopodClient/Types/ValidationResponse.swift` — adds the new URL
  field, removes `screenshotBase64`.
- `Sources/AutopodUI/Models/Pod.swift` — `PageDetail`, `PageScreenshot`,
  `AcCheckDetail` carry URL strings, not base64.
- `Sources/AutopodDesktop/Mapping/PodMapper.swift` — maps the new shape.
- `Sources/AutopodUI/Views/Detail/ScreenshotThumbnail.swift` — switches from
  decoding base64 to fetching URL via `AsyncImage` (or equivalent); becomes
  clickable.
- `Sources/AutopodUI/Views/Detail/ScreenshotLightbox.swift` *(new)* — modal
  overlay rendering the full-resolution image with arrow-key navigation.
- `Sources/AutopodUI/Views/Detail/ValidationTab.swift` — passes the screenshot
  set into the thumbnail for lightbox navigation context.
- `Sources/AutopodUI/Views/Detail/SummaryTab.swift` — same wiring for the
  proof-of-work card.

## Seams

| Seam | Owner brief | Contract |
|------|-------------|----------|
| Disk store ↔ writers (validation engine, pod-manager screenshot collection) | 01 | `ScreenshotStore` interface |
| Daemon HTTP ↔ desktop | 02 (api) and 03 (desktop) | `GET /pods/:id/screenshots/:source/:filename` + JSON `ScreenshotRef[]` |
| Pod terminal-state event ↔ retention sweep | 02 (prune) | Sweeper polls pods in terminal states, calls `ScreenshotStore.delete(podId)` for those past retention |
| ADO PR creation ↔ ADO attachment upload | 02 (ado) | `ado-pr-manager` reads bytes via `ScreenshotStore`, calls ADO PR attachments REST API, embeds the returned attachment URL in the PR body |

## Contracts

### `ScreenshotStore` (daemon-internal)

```ts
export type ScreenshotSource = 'smoke' | 'ac' | 'review';

export interface ScreenshotRef {
  podId: string;
  source: ScreenshotSource;
  filename: string;
  /** Path relative to the data dir, e.g. `screenshots/abc12345/smoke/root.png`. */
  relativePath: string;
}

export interface ScreenshotStore {
  /** Write a PNG to the per-pod source bucket; returns the canonical ref. */
  write(podId: string, source: ScreenshotSource, filename: string, bytes: Buffer): Promise<ScreenshotRef>;
  /** Read raw bytes for serving via HTTP / inline embedding. */
  read(ref: ScreenshotRef): Promise<Buffer>;
  /** List all refs for a pod (used by API serialisers and retention). */
  list(podId: string): Promise<ScreenshotRef[]>;
  /** Delete the entire per-pod tree. Idempotent. */
  delete(podId: string): Promise<void>;
}
```

On-disk layout:

```
<dataDir>/screenshots/
└── <podId>/
    ├── smoke/
    │   ├── root.png
    │   └── about.png
    ├── ac/
    │   ├── 0.png
    │   └── 1.png
    └── review/
        └── 0.png
```

`<dataDir>` resolves the same way as artifacts:
`process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data')`
(see `pod-manager.ts:4520`).

### Daemon API URL contract

```
GET /pods/:podId/screenshots/:source/:filename
  Headers: Authorization: Bearer <user-token-or-pod-token>
  Response: 200 image/png  (raw PNG bytes)
            404 if podId / file missing
            403 if auth fails
```

JSON response shape on `GET /pods/:podId/validations` (and pod detail
endpoints that include validation data):

```ts
interface ScreenshotRefDto {
  url: string;       // e.g. "/pods/abc12345/screenshots/smoke/root.png"
  source: 'smoke' | 'ac' | 'review';
  path: string;      // for smoke: page path; for ac: criterion text; for review: index
}
```

`PageResult.screenshotBase64`, `AcCheckResult.screenshot`, and
`TaskReviewResult.screenshots[]` all become `ScreenshotRefDto | undefined` /
`ScreenshotRefDto[]` in the shared types.

### ADO attachment flow

`ado-pr-manager.createPr` (and `updatePr` if it ever writes screenshots) reads
the PNG bytes from `ScreenshotStore`, POSTs them to the ADO PR attachments
endpoint, and uses the returned attachment URL as the `imageUrl` field on
`ScreenshotRef` for that provider. The relevant ADO REST endpoint is the
attachments collection on the PR resource (api-version 7.1).

If the upload fails, the PR is still created (no screenshots in body) and a
warning is logged — same failure stance as today's `commitFiles` for the git
path.

## UX flows

Lightbox (desktop only — proof-of-work card on Summary tab AND screenshot
thumbnails on Validation tab):

```
┌──────────────────────────────────────────────────┐
│ Detail panel                                     │
│  …                                               │
│  Validation tab → page row → [thumbnail] ◀──┐    │
│                                              │   │
│                                              │   │
│         click thumbnail / press Return       │   │
│                       ▼                      │   │
│  ┌────────────────────────────────────────┐ │   │
│  │ Modal overlay (sheet)                  │ │   │
│  │  ╔════════════════════════════════╗    │ │   │
│  │  ║                                ║    │ │   │
│  │  ║   full-resolution PNG          ║    │ │   │
│  │  ║                                ║    │ │   │
│  │  ╚════════════════════════════════╝    │ │   │
│  │  ◀  /screenshots/smoke/root.png  ▶     │ │   │
│  │                                  [×]   │ │   │
│  │                                        │ │   │
│  │  ESC / click backdrop / [×]: close     │ │   │
│  │  ←/→: prev/next within set             │ │   │
│  └────────────────────────────────────────┘ │   │
└──────────────────────────────────────────────────┘
```

States:
- **Loading** — spinner placeholder while `AsyncImage` fetches.
- **Loaded** — full-resolution PNG, fit to lightbox bounds, preserves aspect.
- **Empty / legacy pod** — thumbnail row shows nothing (no `ScreenshotRef`);
  proof-of-work card is hidden when the screenshot list is empty (already
  the existing behaviour at `SummaryTab.swift:36`).
- **Fetch error** — placeholder with "couldn't load screenshot" copy. Click
  retries.

Set boundary for arrow-key navigation: all `ScreenshotRef`s on the same
validation row, ordered `smoke` → `ac` → `review`, then by filename within
bucket.

## Reference reading

- `docs/decisions/ADR-010-research-pods-filesystem-artifact-storage.md` —
  established the filesystem-over-SQLite pattern. The screenshot exception
  clause ("SQLite-stored validation screenshots remain as-is — small,
  embedded") is partially superseded by ADR-017.
- `packages/daemon/src/api/routes/files.ts` — precedent for serving on-disk
  content via the auth'd HTTP API. Same auth pattern applies.
- `packages/daemon/src/pods/pod-manager.ts:4520` — canonical `dataDir`
  resolution (`process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data')`).
- `packages/daemon/src/validation/screenshot-collector.ts` — current capture
  + base64-encoding flow that the new store replaces.
- `packages/daemon/src/worktrees/pr-body-builder.ts:276` — current PR-body
  Screenshots section rendering. ADO uses `inlineImages: false`
  (`ado-pr-manager.ts:206`), GitHub uses `inlineImages: true`.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ScreenshotThumbnail.swift` —
  shared thumbnail renderer, currently decodes base64.
- `packages/daemon/CLAUDE.md` "Database — Migrations" — migration runner uses
  numeric prefix as schema version; never reuse a number.
- `packages/daemon/backups/` — existing per-deploy DB backup convention; the
  cutover migration must add a snapshot here before running.

## Decisions

- **ADR-017** *(new)*: Move proof-of-work screenshots to disk with retention
  and drop-on-cutover migration. Partially supersedes ADR-010's screenshot
  carve-out.
- **ADR-010** *(existing — partially superseded for screenshots)*: Filesystem
  over SQLite for binary artifacts.

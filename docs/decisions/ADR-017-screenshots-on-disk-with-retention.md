# ADR-017: Proof-of-work screenshots on disk with retention

## Status
Accepted (partially supersedes ADR-010's screenshot carve-out)

## Context

Validation screenshots — Playwright smoke pages, `validate_in_browser`
per-AC checks, and AI task-review artefacts — have been stored as
base64 PNG strings inside JSON columns on the `validations` row since
the daemon's first migration. ADR-010 acknowledged the smell but kept
the carve-out: "SQLite-stored validation screenshots remain as-is —
small, embedded".

Two things changed the calculus:

1. **The daemon DB is at 107 MB and growing monotonically.** A single
   pod can run "Rework 2 — Attempt 5 of 5" with multi-page captures
   per attempt; one pod's screenshots can be tens of MB. There is no
   retention beyond foreign-key cascade on pod delete. Worse, the
   data is doubly-stored: `validation-repository.ts` writes base64
   into a dedicated `screenshots` column AND embeds the same data
   inside the `result` JSON column on the same row.

2. **The desktop wants click-to-zoom UX.** Today's
   `ScreenshotThumbnail.swift` clamps thumbnails at 200–300 px and
   has no path to render full resolution. Streaming base64 over the
   API for a thumbnail is wasteful, and there's no way to lazily
   fetch full-resolution bytes when the user wants them — the field
   is base64 or nothing.

A separate but related bug: ADO PR descriptions render dead
screenshot links because `screenshot-collector.ts` only knows how to
build GitHub raw URLs (`buildGitHubImageUrl`) and the same
`screenshotRefs` object is passed to both PR managers indiscriminately
(`pod-manager.ts:6608`). ADO repos get GitHub URLs that always 404.

## Decision

Move proof-of-work screenshots to disk, served by an auth'd daemon
HTTP route, with periodic retention sweeping for terminal-state pods.

**On-disk layout** (mirrors the artifact layout established by
ADR-010):

```
<dataDir>/screenshots/<podId>/<source>/<filename>.png
```

`<source>` is one of `smoke`, `ac`, `review`. `<dataDir>` resolves
identically to artifacts: `process.env.DATA_DIR ?? path.join
(process.cwd(), '.autopod-data')`. A new daemon-internal
`ScreenshotStore` interface owns reads, writes, listing, and
deletion.

**Wire shape**: the daemon JSON API returns
`{ url, source, path }` (`ScreenshotRefDto`) where `url` is the
relative path of a new auth'd route:

```
GET /pods/:podId/screenshots/:source/:filename
  → 200 image/png
```

The route sits behind the existing auth plugin (same precedent as
`/files`). The desktop fetches lazily via `AsyncImage`-equivalent.
Teams notifications and HTML reports continue to embed inline base64
— they read PNGs from disk and base64-encode at notify/render time.

**Retention**: a periodic sweeper deletes per-pod screenshot
directories for pods in terminal states (`complete | killed |
failed`) past `AUTOPOD_SCREENSHOT_RETENTION_DAYS` (default 30). The
sweeper is polled, not event-driven — a pod transitioning to
terminal does not trigger an immediate delete; the next periodic
tick handles it. Sweep failures are isolated per-pod (one bad delete
doesn't abort the rest).

**Cutover**: a single migration `091_drop_screenshot_blobs.sql`:
1. Drops the `validations.screenshots` column.
2. Strips embedded `screenshotBase64` / `screenshot` /
   `screenshots[]` fields from `validations.result` JSON.

**Drop-on-cutover semantics**: pods that ran before this ships lose
their screenshots permanently from the UI. There is no backfill; the
old base64 bytes are in the pre-migration DB snapshot only.

**Mandatory pre-migration snapshot**: the migration runner copies
the live DB to `packages/daemon/backups/<timestamp>-pre-screenshot-
cutover.db` BEFORE running `091`. The snapshot must succeed or the
migration must not proceed. If the operator needs to roll back, the
recovery procedure is: stop daemon → restore snapshot → revert
daemon/desktop code to a pre-cutover commit → restart.

**ADO dead-link fix**: `ado-pr-manager.ts` uploads PNGs to the ADO
PR attachments REST endpoint (`/_apis/git/repositories/{repoId}/
pullRequests/{prId}/attachments/{fileName}?api-version=7.1`) after
PR creation, then patches the PR body with the returned attachment
URLs. GitHub's path is unchanged — the committed
`.autopod/screenshots/` directory and `buildGitHubImageUrl` flow
remain. If the ADO upload fails, the PR is still created (no
screenshots in body) and a warning is logged; matches today's
`commitFiles` failure stance.

## Consequences

Easier:
- DB stops growing with screenshot data. The `validations` table
  becomes lean (status, timestamps, references, no payload).
- Desktop renders thumbnails by URL, can fetch full resolution on
  demand for the lightbox modal — no oversized base64 strings on
  the wire for views that don't need them.
- ADO PR reviewers see screenshots inline instead of dead links.
- The on-disk layout matches ADR-010's pattern, so future binary
  artifacts have one fewer bespoke path to consider.

Harder:
- Two storage surfaces (SQLite + filesystem) instead of one. Loss
  scenarios are now multi-modal: a corrupted DB still lets you
  inspect screenshots; a deleted disk dir leaves an orphaned
  reference in the validation row's JSON. The daemon's API and
  notification code paths fail-soft on missing files (skip the
  screenshot, log) — this asymmetry is now part of the contract.
- Drop-on-cutover means support / debugging on pre-cutover pods
  can't reach for screenshots. The pre-migration DB snapshot is
  the only escape hatch and it requires a full daemon-rollback
  procedure to use.
- Retention is a new background worker. It must be stopped on
  graceful shutdown alongside the existing 60s commit-polling
  worker. Operators who want pods' screenshots forever must set
  `AUTOPOD_SCREENSHOT_RETENTION_DAYS` to a large value or
  manually disable the sweeper.
- The ADO PR creation flow becomes two-pass (create PR → upload
  attachments → patch body). One more network round-trip per ADO
  pod with screenshots; failure modes for the second pass are new.

Committed to:
- The on-disk layout: `<dataDir>/screenshots/<podId>/<source>/
  <filename>.png` with sources `{ smoke, ac, review }`.
- The auth'd HTTP URL contract:
  `GET /pods/:podId/screenshots/:source/:filename`. Desktop
  hard-codes this path.
- The wire shape: `ScreenshotRefDto = { url, source, path }`.
- The retention env var name:
  `AUTOPOD_SCREENSHOT_RETENTION_DAYS` (default 30).
- Drop-on-cutover migration semantics. There is no plan to ever
  backfill pre-cutover screenshots.

This ADR partially supersedes ADR-010's screenshot carve-out
clause ("SQLite-stored validation screenshots remain as-is —
small, embedded"). The rest of ADR-010 (filesystem-over-SQLite for
binary artifacts) stands.

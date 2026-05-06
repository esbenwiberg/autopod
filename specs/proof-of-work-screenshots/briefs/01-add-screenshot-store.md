---
title: "Add disk screenshot store + cutover migration"
depends_on: []
acceptance_criteria:
  - { type: cmd, test: "test -f packages/daemon/src/pods/screenshot-store.ts", pass: "exit 0", fail: "the store module wasn't created" }
  - { type: cmd, test: "! grep -nE 'screenshotBase64|screenshots\\\\b' packages/daemon/src/pods/validation-repository.ts", pass: "exit 0 — no base64 / no `screenshots` column writes remain", fail: "the repository still writes the legacy base64 path" }
  - { type: cmd, test: "test -f packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql", pass: "exit 0", fail: "the cutover migration is missing" }
touches:
  - packages/daemon/src/pods/screenshot-store.ts
  - packages/daemon/src/pods/screenshot-store.test.ts
  - packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql
  - packages/daemon/src/db/migrate.ts
  - packages/daemon/src/pods/validation-repository.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/validation/screenshot-collector.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/escalation-mcp/src/tools/validate-in-browser.ts
  - packages/shared/src/types/validation.ts
does_not_touch:
  - packages/daemon/src/api/routes/
  - packages/daemon/src/notifications/
  - packages/daemon/src/validation/report-generator.ts
  - packages/daemon/src/worktrees/ado-pr-manager.ts
  - packages/desktop/
---

## Task

Land the on-disk screenshot store, migrate the DB to drop the legacy
base64 blobs, and rewire every existing **writer** (validation engine,
pod-manager screenshot collection path, escalation-mcp browser tool) to
write through the store instead of stuffing base64 into SQLite.

This brief is the foundation. Briefs 02-* (api, prune, ado) and 03
(desktop) all depend on the on-disk layout and the new shared-types
shape that this brief defines.

### `ScreenshotStore` module

Create `packages/daemon/src/pods/screenshot-store.ts` matching the
contract in `design.md` → Contracts (`ScreenshotStore` interface +
`ScreenshotRef`). Constructor takes a `dataDir: string`. Resolve paths
exactly the same way `pod-manager.ts:4520` resolves `dataDir`:
`process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data')`.

On-disk layout:

```
<dataDir>/screenshots/<podId>/<source>/<filename>.png
```

`<source>` is one of `smoke`, `ac`, `review`. Filenames are caller-
chosen but the store MUST sanitise: reject any `..` segment or path
separator; whitelist `[A-Za-z0-9._-]` only and lowercase the extension
to `.png`. A bad filename throws — do not silently rename.

`write` is `mkdir -p` + atomic write (write to `.tmp` sibling, rename
into place). `read` returns the raw `Buffer`. `list` walks the per-pod
tree and returns refs in the canonical order `smoke → ac → review`,
filename-sorted within each bucket. `delete` is `rm -rf` of the per-pod
tree and is idempotent (no error when the dir is missing).

Co-locate `screenshot-store.test.ts` exercising:

- write+read round-trip for each source
- bad filename rejection (path traversal, non-PNG extension, slashes)
- `list` ordering invariant
- `delete` idempotency
- `write` with concurrent calls for the same `(podId, source,
  filename)` (last writer wins; no torn files)

### Cutover migration

Create
`packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql`. It
must:

1. Drop the `validations.screenshots` column outright.
2. Rewrite `validations.result` JSON to strip three fields wherever
   present:
   - `result.smoke.pages[].screenshotBase64`
   - `result.acValidation.checks[].screenshot`
   - `result.taskReview.screenshots[]`

Use SQLite's JSON1 functions (`json_remove`, `json_set`, `json_each`)
to do the rewrite in pure SQL — no Node-side iteration. If a
single-statement rewrite is awkward, the migration may use multiple
`UPDATE`s; the runner wraps each `.sql` file in an implicit
transaction so atomicity is preserved.

Schema-version note: the highest existing migration is `090`. Use
`091`. Never reuse a prefix (per `daemon/CLAUDE.md` → "Database —
Migrations"). Verify `ls packages/daemon/src/db/migrations/ | tail -5`
before naming the file.

### Pre-migration DB snapshot

`migrate.ts` MUST copy the live DB to
`packages/daemon/backups/<ISO-timestamp>-pre-screenshot-cutover.db`
**before** applying `091`. The directory exists (it's the existing
backup convention). Use `fs.copyFileSync(dbPath, backupPath)` after
the migration runner has computed which migrations are pending and
discovered that `091` is among them — do NOT snapshot on every boot.

If `dbPath === ':memory:'` (the in-memory test DB used by
`createTestDb()`), skip the snapshot. Tests run the migration
unconditionally without producing backup files.

If the snapshot copy fails, the migration must NOT proceed. Log the
failure and exit with the same error path the runner uses today for
SQL failures.

### Shared types

Edit `packages/shared/src/types/validation.ts`:

- Replace `PageResult.screenshotBase64?: string` with
  `screenshot?: ScreenshotRef`.
- Replace `AcCheckResult.screenshot?: string` (currently a base64
  string) with `screenshot?: ScreenshotRef`.
- Replace `TaskReviewResult.screenshots?: string[]` with
  `screenshots?: ScreenshotRef[]`.
- Export a new `ScreenshotRef` interface matching `design.md` →
  Contracts:
  ```ts
  export type ScreenshotSource = 'smoke' | 'ac' | 'review';
  export interface ScreenshotRef {
    podId: string;
    source: ScreenshotSource;
    filename: string;
    /** Path relative to the data dir. */
    relativePath: string;
  }
  ```

Drop-on-cutover: there is no backwards-compat alias for the old field
names. Pre-cutover validation rows lose their screenshots — that's by
design (`purpose.md` → Non-goals).

### `validation-repository.ts`

Stop writing base64 anywhere. Specifically:

- Remove the `screenshots` column from the INSERT statement (it's
  being dropped by `091`).
- When serialising `result` JSON for the `result` column, do NOT embed
  base64 in the smoke/ac/review nested fields. The new
  `ScreenshotRef` shape is what flows through.

Tests in `validation-repository.test.ts` (already exists) must be
updated to exercise the new shape — drop any base64 fixtures.

### `pod-manager.ts` writer site

Replace `page.screenshotBase64 = ss.base64` (line ~6295) with a write
through `ScreenshotStore`:

```ts
const ref = await screenshotStore.write(
  pod.id,
  'smoke',
  `${slugify(page.path)}.png`,
  ss.bytes,
);
page.screenshot = ref;
```

`screenshotStore` is a new field on `PodManager` — add it to the
constructor's options and wire it from `index.ts`. The store is a
singleton per daemon, like the repositories.

The smoke-screenshot collection path is the **only** assignment site
this brief touches in `pod-manager.ts`. The ADO PR-body integration
(brief 02-ado) and the terminal-state retention hook (brief
02-prune) are explicit non-touches for this brief.

### `screenshot-collector.ts`

Reads PNGs from the worktree (`.autopod/screenshots/`). Today it
returns base64. After this brief: writes through `ScreenshotStore` and
returns `ScreenshotRef[]`. The committed `.autopod/screenshots/`
directory is left in place — that path is the GitHub PR-rendering
mechanism and is explicitly preserved (`purpose.md` → Non-goals).

The `buildGitHubImageUrl` helper stays — brief 02-ado adds the
provider-aware sibling. This brief does NOT change PR-body rendering.

### `local-validation-engine.ts`

The AC-check screenshot path (today: hands a base64 string up via
`AcCheckResult.screenshot`) routes its bytes through
`ScreenshotStore.write(podId, 'ac', `${idx}.png`, bytes)` and stores
the returned `ScreenshotRef` on `AcCheckResult.screenshot`.

Same for the task-review screenshots: write each into the `review`
source bucket, return the `ScreenshotRef[]`.

### Escalation MCP

`packages/escalation-mcp/src/tools/validate-in-browser.ts` currently
includes the base64 screenshot in the tool result. The agent never
reads the screenshot field (only `passed` / `reasoning` —
`purpose.md` → Non-goals). Rewire so the bytes are passed via the
existing `PodBridge` to the daemon, which writes through
`ScreenshotStore` and returns a `ScreenshotRef`. The tool response
field name stays the same on the wire (whatever it is today) but
carries `ScreenshotRef` instead of a base64 string.

If the bridge doesn't already have a method for "store screenshot
bytes", add one (e.g. `PodBridge.storeScreenshot(podId, source,
filename, bytes): Promise<ScreenshotRef>`) and implement it in
`pod-bridge-impl.ts` by delegating to the store.

## Touches

- `packages/daemon/src/pods/screenshot-store.ts` *(new)* — the store
  itself.
- `packages/daemon/src/pods/screenshot-store.test.ts` *(new)* —
  round-trip + safety + ordering tests.
- `packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql`
  *(new)* — column drop + result JSON rewrite.
- `packages/daemon/src/db/migrate.ts` — pre-`091` snapshot to
  `packages/daemon/backups/`.
- `packages/daemon/src/pods/validation-repository.ts` — stop writing
  base64 / `screenshots` column; serialise the new shape.
- `packages/daemon/src/pods/pod-manager.ts` — only the smoke
  screenshot-assignment site (line ~6295). Wire the store into the
  constructor.
- `packages/daemon/src/validation/screenshot-collector.ts` — write
  through store; return `ScreenshotRef[]`.
- `packages/daemon/src/validation/local-validation-engine.ts` — AC +
  task-review screenshot writes through store.
- `packages/escalation-mcp/src/tools/validate-in-browser.ts` — bytes
  via PodBridge, not in the tool response.
- `packages/shared/src/types/validation.ts` — `ScreenshotRef` +
  replaced field shapes.

## Does not touch

- `packages/daemon/src/api/routes/` — brief 02-api owns serialisation
  + the new screenshot-serving route.
- `packages/daemon/src/notifications/` — brief 02-api owns the
  notify-time encode-from-disk rewire.
- `packages/daemon/src/validation/report-generator.ts` — brief 02-api
  owns the HTML-report encode-from-disk rewire.
- `packages/daemon/src/worktrees/ado-pr-manager.ts` — brief 02-ado.
- `packages/daemon/src/pods/screenshot-retention.ts` — brief
  02-prune.
- `packages/desktop/` — brief 03.

## Constraints

From `design.md` → Contracts: the `ScreenshotStore` interface and
`ScreenshotRef` shape are frozen. Other briefs depend on them.

From `purpose.md` → Reversibility: the migration is irreversible
without the snapshot. Snapshot-before-migrate is mandatory and must
fail closed (no migration if snapshot fails).

From `purpose.md` → Non-goals: `.autopod/screenshots/` git-commit
path stays untouched. Workspace pods don't run validation, so they
never hit any of these writer sites — no special-case needed.

## Test expectations

`screenshot-store.test.ts`:
- Write a 4×4 PNG buffer to each source, read it back, bytes match.
- `write` rejects filenames containing `..`, `/`, or non-`.png`.
- `list(podId)` returns refs in `smoke → ac → review` order, sorted
  alphabetically within each bucket.
- `delete(podId)` removes the per-pod tree; second `delete` call is
  a no-op.

`migrate.test.ts` (or wherever the migration runner is tested):
- Apply `091` against a DB that has rows with the legacy
  `screenshots` column populated and the `result` JSON containing
  embedded base64 fields. Confirm:
  - The `screenshots` column is gone (PRAGMA `table_info(validations)`).
  - `result.smoke.pages[i].screenshotBase64` is undefined post-migration.
  - `result.acValidation.checks[i].screenshot` is undefined.
  - `result.taskReview.screenshots` is undefined.
- Confirm the snapshot file appears under `packages/daemon/backups/`
  before the migration runs (use a tmp `dbPath`, not `:memory:`).
- Confirm the in-memory test DB path skips the snapshot.
- If `fs.copyFileSync` is monkey-patched to throw, confirm `091` does
  NOT apply (column still present).

`validation-repository.test.ts`:
- Round-trip a `ValidationResult` with `ScreenshotRef`s embedded;
  read back and assert refs survive (no base64 anywhere).
- Confirm the `screenshots` column is no longer referenced.

`screenshot-collector.test.ts` (already exists):
- Update fixtures: collector returns `ScreenshotRef[]`, not
  `{ base64, ... }[]`.

`pod-manager` smoke-collection path: the existing pod-lifecycle e2e
test should already exercise this; update its assertion to look for
`page.screenshot` (a `ScreenshotRef`) instead of
`page.screenshotBase64`.

## Risks / pitfalls

- **Doubly-stored blobs.** `validation-repository.ts` writes
  screenshot data twice today — once into the dedicated `screenshots`
  column, once embedded inside `result` JSON (as
  `result.smoke.pages[].screenshotBase64`, etc.). Both paths must be
  removed; if the migration only drops the column, the JSON
  duplicate keeps bloating the DB.

- **Migration runner inside tests.** `createTestDb()` runs all
  migrations against an in-memory DB. If `091` does any operation
  the in-memory backend doesn't support (it shouldn't — JSON1 is
  built-in to better-sqlite3), tests blow up across the codebase.
  Smoke-test the migration against `createTestDb()` early.

- **Snapshot path collision.** If two daemons start within the same
  ISO second on the same backups directory, the filename collides.
  Use ISO with millisecond precision (e.g.
  `new Date().toISOString().replace(/[:.]/g, '-')`) and tolerate
  collision by failing — multiple daemons against the same DB is
  already broken.

- **PodBridge surface.** Adding a new bridge method ripples to any
  test that mocks `PodBridge`. Search for `PodBridge` in
  `packages/escalation-mcp/` and `packages/daemon/` and update
  every mock to include the new `storeScreenshot` (or chosen name)
  method, or stub it to throw "not implemented" with a clear
  message.

- **AC index uniqueness.** AC checks are referred to by index in the
  current code. If two checks happen to produce screenshots in the
  same loop iteration, filename `${idx}.png` collides. Use
  `${attemptId}-${idx}.png` or include a counter — verify against
  the loop in `local-validation-engine.ts` before settling on the
  scheme.

- **Slug clashes for smoke pages.** Two smoke pages with paths
  `/foo` and `/foo/` slugify to the same filename. Disambiguate
  (append a hash, or include the page index) — matches today's
  behaviour where same-named files in `.autopod/screenshots/`
  overwrite.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm build` — passes (transitive type-check across
   shared/daemon/escalation-mcp).
3. `npx pnpm --filter @autopod/daemon test` — passes.
4. `npx pnpm --filter @autopod/escalation-mcp test` — passes.
5. `npx pnpm --filter @autopod/shared test` — passes.
6. Manual smoke: spawn a pod that runs validation, confirm PNGs
   appear under `<dataDir>/screenshots/<podId>/smoke/` and the
   `validations.result` JSON has `ScreenshotRef`s instead of base64.
7. Confirm the backup file shows up in `packages/daemon/backups/`
   on first daemon boot post-migration.
8. Commit and push.

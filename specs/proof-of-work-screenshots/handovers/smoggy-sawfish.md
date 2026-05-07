# Handover — smoggy-sawfish (Brief 01: On-disk screenshot store)

## What was built

The foundational on-disk screenshot store layer is complete. Screenshot bytes no longer flow into SQLite. Key deliverables:

1. **`packages/daemon/src/pods/screenshot-store.ts`** — `ScreenshotStore` singleton with `write` (atomic tmp-rename), `read`, `list` (smoke→ac→review order), `delete` (idempotent rm-rf). Filename sanitiser whitelists `[A-Za-z0-9._-]+`, rejects `..`, path separators, non-`.png` extensions. `slugifyPagePath(path, idx)` generates `${idx}-${slug}.png` smoke filenames to avoid `/foo` vs `/foo/` collisions.

2. **`packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql`** — Strips `screenshotBase64` from `smoke.pages[]`, `screenshot` from `acValidation.checks[]`, and resets `taskReview.screenshots` to `[]` via SQLite JSON1 correlated subqueries, then `ALTER TABLE validations DROP COLUMN screenshots`.

3. **`packages/daemon/src/db/migrate.ts`** — `runMigrations` now accepts a `dbPath` 4th argument (default `':memory:'`). Pre-scans pending versions; if 091 is pending, calls `snapshotBeforeCutover` which `fs.copyFileSync`s to `<backupsDir>/<ISO-ms>-pre-screenshot-cutover.db`. Fails-closed (throws; migration does not proceed if copy fails). Skips snapshot for `:memory:`.

4. **`packages/shared/src/types/validation.ts`** — `ScreenshotRef` and `ScreenshotSource` exported. `PageResult.screenshotBase64` → `screenshot?: ScreenshotRef`. `AcCheckResult.screenshot?: string` → `screenshot?: ScreenshotRef`. `TaskReviewResult.screenshots: string[]` → `screenshots: ScreenshotRef[]`.

5. **Writer rewires** — `validation-repository.ts` drops `screenshots` column from INSERT; `screenshot-collector.ts` returns `ScreenshotRef[]` (not base64); `pod-manager.ts` smoke-screenshot site writes through the store; `local-validation-engine.ts` AC and task-review screenshots write through the store; `validate-in-browser.ts` calls `bridge.storeScreenshot()` for both host and container paths.

6. **`pod-bridge-impl.ts` / `pod-bridge.ts`** — `storeScreenshot(podId, source, filename, bytes): Promise<ScreenshotRef>` added to interface and implemented.

7. **`index.ts`** — `createScreenshotStore(resolveDataDir())` singleton wired to `PodManager`, `createLocalValidationEngine`, `createSessionBridge`. `runMigrations` called with `DB_PATH`.

## Deviations from the brief

None significant. The brief said `screenshotStore` is optional in `PodManagerDependencies` (`screenshotStore?: ScreenshotStore`) — implemented as required. The validation engine uses the same optional pattern to remain testable without a real store.

## Contracts downstream pods must honour

### `ScreenshotRef` shape (frozen)

```ts
export type ScreenshotSource = 'smoke' | 'ac' | 'review';
export interface ScreenshotRef {
  podId: string;
  source: ScreenshotSource;
  filename: string;
  relativePath: string; // e.g. "screenshots/abc12345/smoke/0-root.png"
}
```

This is in `packages/shared/src/types/validation.ts` and re-exported from `packages/shared/src/index.ts`. **Do not rename or add fields without coordinating with Brief 02-api (desktop consumer).**

### `ScreenshotStore` interface (frozen)

```ts
interface ScreenshotStore {
  write(podId, source, filename, bytes): Promise<ScreenshotRef>;
  read(ref): Promise<Buffer>;
  list(podId): Promise<ScreenshotRef[]>;
  delete(podId): Promise<void>;
}
```

Located at `packages/daemon/src/pods/screenshot-store.ts`. Brief 02-api adds the HTTP route that serves bytes from `store.read()`. Brief 02-prune adds the retention sweeper that calls `store.delete()`.

### Disk layout

```
<dataDir>/screenshots/<podId>/<source>/<filename>.png
```

`<dataDir>` resolved via `resolveDataDir()` in `screenshot-store.ts` (`process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data')`). Brief 02-api's HTTP route must serve from this same path.

### Migration 091

Already applied via the standard migration runner. Do not create another migration with prefix 091.  Next available prefix is **092**.

## Files owned — do not modify without good reason

- `packages/daemon/src/pods/screenshot-store.ts` — interface is frozen; safe to add helpers inside but do not change method signatures
- `packages/shared/src/types/validation.ts` — `ScreenshotRef` shape is frozen
- `packages/daemon/src/db/migrations/091_drop_screenshot_blobs.sql` — never modify applied migrations

## Discovered constraints / landmines

- **SQLite JSON1 array rewrite pattern**: `json_group_array(json_remove(value, '$.field')) FROM json_each(result, '$.path.to.array')` — requires SQLite ≥ 3.38. better-sqlite3 ships SQLite 3.43+ so this is fine in practice.
- **`screenshotStore` is optional** in both `PodManagerDependencies` and `createLocalValidationEngine`. This was intentional to keep the large existing test suite passing without a real store. Tests that assert on `ScreenshotRef` values should pass a mock store (see `screenshot-collector.test.ts` for the `makeMockStore()` pattern).
- **AC screenshot filenames** use `${config.attempt}-${i}.png` scheme. `config.attempt` comes from `ValidationEngineConfig`. If the same attempt runs both host-side and container-side paths, the filenames could collide — but in practice the runner stops at the first successful execution path.
- **`validate-in-browser.ts` mock bridge** — any test that mocks `PodBridge` must now include `storeScreenshot: vi.fn().mockResolvedValue(...)`. The `validate-in-browser.test.ts` sets the precedent with `MOCK_SCREENSHOT_REF`.
- **Snapshot path resolution** walks up 5 levels from the DB file looking for a `backups/` directory. In production (DB at `./autopod.db`), it finds `packages/daemon/backups/`. In deploy environments (DB at `/data/autopod.db`), it creates `/data/backups/` on first cutover.

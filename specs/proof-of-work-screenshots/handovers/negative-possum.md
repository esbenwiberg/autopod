# Handover — negative-possum (Brief 02-ado: ADO PR attachment upload)

## What was built

The dead-screenshot-link bug on Azure DevOps PRs is fixed. Key deliverables:

1. **`packages/daemon/src/validation/screenshot-collector.ts`** — Added `buildAdoAttachmentRef(pagePath, attachmentUrl)` helper that maps a stored screenshot ref + ADO-returned attachment URL to the `{ pagePath, imageUrl }` shape consumed by `buildPrBody`. Required by acceptance-criteria grep.

2. **`packages/daemon/src/interfaces/pr-manager.ts`** — Added `rawScreenshots?: Array<{ pagePath: string; ref: ScreenshotRef }>` to `CreatePrConfig`. GitHub PR manager ignores this field; ADO uses it to upload screenshots after PR creation. `ScreenshotRef` imported from `@autopod/shared`.

3. **`packages/daemon/src/worktrees/ado-pr-manager.ts`** — Major changes:
   - `AdoPrManagerConfig` has optional `screenshotStore?: ScreenshotStore`
   - `uploadScreenshotAttachments(prId, rawScreenshots)` private method: sequential uploads to `/_apis/git/repositories/{repo}/pullRequests/{prId}/attachments/{source}-{filename}?api-version=7.1` (source-prefixed to avoid bucket collisions). Non-fatal: failed uploads are skipped, warning logged.
   - `createPr()` now two-pass for ADO: build body with empty screenshots → create PR → upload attachments → PATCH description with attachment URLs. If all uploads fail, the screenshots section is simply omitted.

4. **`packages/daemon/src/pods/pod-manager.ts`** (~line 6608) — Provider-aware branch:
   - ADO (`profile.prProvider === 'ado'`): builds `rawScreenshots` from `result.smoke.pages[].screenshot` (on-disk `ScreenshotRef`). `screenshotRefs` is empty for ADO.
   - GitHub: keeps existing `buildGitHubImageUrl` path unchanged.
   - Both fields passed to `prManager.createPr()`.

5. **`packages/daemon/src/index.ts`** — `prManagerFactory` now passes `screenshotStore` to `new AdoPrManager(...)`.

6. **Tests** — New `createPr` test suite in `ado-pr-manager.test.ts`: happy path (2 screenshots, PATCH body has URLs), two-pass order, upload failure (no throw, warn logged, partial success), auth header, no-screenshot pods (0 attachment calls). `screenshot-collector.test.ts` tests `buildAdoAttachmentRef` and the no-URL invariant on collected refs.

## Deviations from brief

None. The brief described the two-pass pattern, failure stance, and test expectations exactly as implemented.

## Contracts downstream pods must honour

### `CreatePrConfig` changes (frozen)
```ts
// In packages/daemon/src/interfaces/pr-manager.ts
screenshots?: Array<{ pagePath: string; imageUrl: string }>;  // unchanged (GitHub)
rawScreenshots?: Array<{ pagePath: string; ref: ScreenshotRef }>;  // new (ADO)
```
The GitHub PR manager (`pr-manager.ts`) ignores `rawScreenshots`. The ADO PR manager ignores `screenshots` when `rawScreenshots` is provided.

### `AdoPrManagerConfig` changes
`screenshotStore?: ScreenshotStore` is now an optional field. Existing tests that construct `AdoPrManager` without it still work (no-screenshots path).

### `buildAdoAttachmentRef` (screenshot-collector.ts)
```ts
export function buildAdoAttachmentRef(pagePath: string, attachmentUrl: string): { pagePath: string; imageUrl: string }
```
Thin helper. The ADO attachment flow depends on it at `ado-pr-manager.ts:uploadScreenshotAttachments`.

## Files owned — do not modify without good reason

- `packages/daemon/src/worktrees/ado-pr-manager.ts` — the two-pass upload flow is complete; do not add a parallel-upload path (ADO rate-limits).
- `packages/daemon/src/interfaces/pr-manager.ts` — `rawScreenshots` field is the seam between pod-manager and ADO manager; its type must stay `Array<{ pagePath, ref: ScreenshotRef }>`.

## Discovered constraints / landmines

- **Sequential uploads are intentional.** ADO rate-limits attachment bursts. Using `Promise.all` was explicitly ruled out in the brief. The `for...of` loop in `uploadScreenshotAttachments` is correct.
- **Filename collision avoidance.** ADO attachment filenames are PR-scoped. The `${ref.source}-${ref.filename}` prefix (e.g. `smoke-0-root.png`) prevents collisions between smoke/ac/review buckets.
- **`screenshotStore` is optional** in `AdoPrManagerConfig`. Without a store, `hasRawScreenshots` is false and no uploads fire. This preserves testability.
- **`body: bytes as unknown as BodyInit`** cast in `uploadScreenshotAttachments` — needed because `Buffer` (Node.js) extends `Uint8Array` which is `ArrayBufferView ⊂ BodyInit`, but TypeScript's lib definitions don't always reflect this. The `as unknown as BodyInit` double-cast is intentional.
- **Brief 02-api (HTTP route for screenshots)** and **Brief 03 (desktop lightbox)** are upstream from this pod. Brief 02-api should add `GET /pods/:podId/screenshots/:source/:filename` endpoint served from the screenshot store. Brief 03 should use URL refs from that endpoint.
- **ADO PAT scope.** If attachment uploads 401/403 in real usage, the PAT lacks Code (Read & Write) / `vso.code_full` scope. The warning message calls this out explicitly.

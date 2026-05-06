---
title: "Render screenshots from URL + add lightbox to desktop"
depends_on: [02-expose-screenshots-api]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ScreenshotThumbnail.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ScreenshotLightbox.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
---

## Task

Switch the desktop from base64-decoded thumbnails to URL-fetched
images, and add a click-to-zoom lightbox modal that renders
screenshots at full resolution with arrow-key navigation across the
validation attempt's screenshot set.

This is a Swift / SwiftUI brief. No `api` / `web` / `cmd` AC fires
against a native macOS app — gating leans on the diff reviewer plus
the test expectations below.

### API layer — `ValidationResponse.swift`

Replace the base64 fields in the daemon JSON decode with the
`ScreenshotRefDto` shape:

```swift
public struct ScreenshotRef: Codable, Hashable, Sendable {
  public let url: String
  public let source: String   // "smoke" | "ac" | "review"
  public let path: String     // page path | criterion text | index
}
```

In `PageResult` / `AcCheckResult` / `TaskReviewResult` (whatever
their existing names are in
`Sources/AutopodClient/Types/ValidationResponse.swift`):

- Remove the base64 string fields.
- Add `screenshot: ScreenshotRef?` (smoke + ac).
- Add `screenshots: [ScreenshotRef]?` (review).

Match the JSON keys produced by brief 02-api exactly. The DTO
field names are `url`, `source`, `path` — no remapping.

### UI model — `Pod.swift`

`PageScreenshot`, `AcCheckDetail`,
`ValidationChecks.proofOfWorkScreenshots` (lines ~130–220 in
`Sources/AutopodUI/Models/Pod.swift`) currently carry base64
strings. Update them to carry a Swift-side equivalent of
`ScreenshotRef`:

```swift
public struct ScreenshotRef: Hashable, Sendable {
  public let url: URL          // resolved against daemon base URL
  public let source: Source    // smoke | ac | review
  public let label: String     // page path | criterion text | index
  public enum Source: String { case smoke, ac, review }
}
```

The `url` is constructed at mapping time from the daemon base URL
(already known to the desktop client) + the relative path returned
by the daemon (`/pods/:id/screenshots/...`).

The `proofOfWorkScreenshots` collection on `ValidationChecks`
becomes `[ScreenshotRef]` — the proof-of-work card is always a
flat list across the three sources for a given attempt.

### Mapper — `PodMapper.swift`

`Sources/AutopodDesktop/Mapping/PodMapper.swift` decodes the
network DTO into the UI model. Update each call site that
previously decoded `screenshotBase64` strings to:

- Read `dto.screenshot` / `dto.screenshots` (the new
  `ScreenshotRef`-shaped fields).
- Resolve the `url` field against the daemon base URL into a
  proper `URL`. The base URL is on the API client; thread it
  through the mapper if it isn't already.
- Map `source` string into the Swift enum.
- Map `path` string into the model's `label`.

Drop `nil` refs silently — a validation row that has no smoke
screenshot for a page (e.g. capture failed) results in an empty
list, not a placeholder.

### Thumbnail —
`Sources/AutopodUI/Views/Detail/ScreenshotThumbnail.swift`

Today: `func screenshotThumbnail(_ base64: String?, maxHeight:
CGFloat = 300)` decodes base64, clamps at 300 px.

After this brief:

- Signature change to take a `ScreenshotRef?` (or a non-optional
  ref + an outer guard).
- Replace base64 decode with `AsyncImage(url: ref.url)`. Pass the
  daemon's auth token via a custom `URLRequest`-backed
  `AsyncImage` if the existing one doesn't honour
  `Authorization` headers — search the codebase for an existing
  authenticated image view; the file-listing UI almost certainly
  has one. Reuse it. If none exists, build a thin
  `AuthenticatedAsyncImage` that wraps `URLSession`-fetched
  bytes into an `Image`.
- Loading state: a small spinner at the same frame size.
- Error state: a `Image(systemName: "photo.badge.exclamationmark")`
  with a tap-to-retry gesture.
- Make the thumbnail clickable. The click handler opens the
  lightbox at the clicked ref. The set of refs (for arrow-key
  nav inside the lightbox) is supplied by the parent.

### Lightbox —
`Sources/AutopodUI/Views/Detail/ScreenshotLightbox.swift` *(new)*

A SwiftUI overlay (use `.sheet` if a sheet matches the macOS feel,
or a custom `.overlay(...)` with a translucent backdrop — match
whatever modal pattern the app already uses; do not invent a new
one). Inputs:

```swift
struct ScreenshotLightbox: View {
  let refs: [ScreenshotRef]   // the set
  @Binding var currentIndex: Int
  @Binding var isPresented: Bool
}
```

States (per `design.md` → UX flows):

- **Loading** — spinner at the lightbox frame.
- **Loaded** — full-resolution PNG, fit to bounds, preserves
  aspect ratio. No upscaling beyond native pixels.
- **Empty** — never reached; the lightbox is only opened with a
  non-empty `refs`.
- **Fetch error** — placeholder + "couldn't load screenshot" copy
  + tap-to-retry.

Controls:

- ESC, click on backdrop, or click `[×]` button → close
  (`isPresented = false`).
- Left/Right arrow keys → previous/next ref (clamped at array
  bounds; no wrap-around).
- Caption shows the current ref's relative URL path (e.g.
  `/screenshots/smoke/root.png`) so the reviewer can anchor what
  they're looking at.

Set ordering (per `design.md` → UX flows): `smoke → ac → review`,
filename-sorted within bucket. The mapper already orders refs in
that canonical order — the lightbox just walks the array linearly.

Keyboard handling on macOS SwiftUI: the standard pattern is
`.onMoveCommand` or `.keyboardShortcut`. Use whichever the app
already uses for keyboard-driven views; consistency wins.

### Validation tab — `ValidationTab.swift`

Each page row currently shows a thumbnail. After this brief:

- Pass the `[ScreenshotRef]` set for the validation attempt into
  every thumbnail in the tab.
- The thumbnail click handler sets `lightboxRefs = set;
  lightboxIndex = clickedIndex; isLightboxPresented = true`.
- The lightbox is presented at the tab level (not per-thumbnail) —
  one `@State` for the presented set.

### Summary tab — `SummaryTab.swift`

The proof-of-work card at line ~344 today renders thumbnails at
`maxHeight: 200`. After this brief:

- Same wiring: the card holds the validation's full screenshot
  set and presents the lightbox on click.
- Empty-state behaviour: `proof-of-work card is hidden when the
  screenshot list is empty (already the existing behaviour at
  `SummaryTab.swift:36`)`. Don't change that.

The 200 px max-height is a UI choice for the card; it can stay or
go up to ~280 px if the design feels cramped — within the brief
writer's discretion. The lightbox is the answer for "I want to see
the full thing"; the card just needs to be readable.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift`
  — DTO swap base64 → `ScreenshotRef`.
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift` — UI model
  swap; `ScreenshotRef` Swift type.
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift`
  — DTO → UI mapping; URL resolution against daemon base.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ScreenshotThumbnail.swift`
  — `AsyncImage` rewire, click handler.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ScreenshotLightbox.swift`
  *(new)* — modal overlay.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift`
  — set + lightbox wiring.
- `packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift`
  — set + lightbox wiring on the proof-of-work card.

## Does not touch

- `packages/daemon/` — daemon-side work is finished by briefs 01,
  02-api, 02-prune, 02-ado.
- `packages/shared/` — shared types frozen by brief 01.
- All other packages.

## Constraints

From `design.md` → Contracts: the URL shape is
`/pods/:podId/screenshots/:source/:filename`. Hard-code it in the
mapper (or accept the daemon's `url` as-is if it's already a full
relative path) — do NOT reconstruct from `relativePath`.

From `design.md` → UX flows: the set ordering for arrow nav is
`smoke → ac → review`, filename-sorted within bucket. The
daemon's `list` already returns refs in this order; preserve it
through the mapper.

From `purpose.md` → Non-goals: "no `web` AC is possible against a
native macOS app". This brief has zero ACs in frontmatter — gating
relies on Test expectations and the diff reviewer.

From `purpose.md` → Users: legacy pods (no screenshots in DB
post-cutover) show "no screenshots" — the existing empty-state
hides the card. Don't add a placeholder image.

From the project memory note (`project_desktop_ac_display.md`):
session AC display in the macOS app has open design questions.
Do not let this brief drift into resolving them — stay focused on
the screenshot UX.

## Test expectations

Swift unit tests (in whatever test target the desktop package
uses — match the existing convention):

- **Decoder round-trip.** Given a JSON payload from brief 02-api
  with `screenshot: { url, source, path }`, the decoder produces
  the expected `ScreenshotRef` Swift value.
- **Decoder absent fields.** A page with no screenshot decodes to
  `screenshot: nil`. Empty `screenshots: []` array decodes to
  empty.
- **Mapper URL resolution.** Given a daemon base URL
  `http://127.0.0.1:3100` and a DTO `url:
  /pods/abc12345/screenshots/smoke/root.png`, the mapped
  `ScreenshotRef.url` is the absolute URL.
- **Set ordering.** A mixed bag of smoke + ac + review refs maps
  through with the canonical ordering preserved.

Manual UI verification (no automated path):

- Spawn a real pod with smoke screenshots; open the desktop;
  confirm thumbnails load, clicks open the lightbox, arrow keys
  navigate, ESC closes.
- Toggle network failure (kill the daemon mid-load); confirm
  thumbnails show the error placeholder; tap retries.
- Confirm a pod with zero screenshots shows the empty state on
  the Summary tab (no card).
- Confirm a pre-cutover pod (validations row pre-migration) shows
  no screenshots — also empty state, not a crash.

## Risks / pitfalls

- **`AsyncImage` and auth headers.** SwiftUI's vanilla
  `AsyncImage` doesn't take a custom `URLRequest`. If the daemon
  enforces auth on the screenshot route (it does — brief 02-api
  matches the `files.ts` auth precedent), `AsyncImage` will fail
  with 401. The desktop must either:
  (a) Use the existing authenticated image fetcher (search the
      codebase first — file-browsing UI already does this).
  (b) Build a thin wrapper around `URLSession.dataTask` that
      injects the bearer token, decodes to `NSImage`, exposes via
      `@StateObject`.
  Don't ship vanilla `AsyncImage` to a route that needs auth.

- **Lightbox keyboard focus.** The lightbox needs to actually
  receive arrow keys. SwiftUI on macOS is finicky about
  first-responder for views inside sheets — test arrow-key nav
  on the actual app, not just in unit tests. If `.onMoveCommand`
  doesn't fire reliably, fall back to a `KeyboardEventCatcher`
  pattern (NSViewRepresentable that catches NSEvent.keyDown).

- **High-res PNGs and memory.** The full-resolution images are
  1280×720 today (per `purpose.md` → Non-goals). Memory cost is
  fine. If an agent ever bumps DPR (out of scope), reassess.

- **URL caching.** The daemon's `Cache-Control: immutable`
  (brief 02-api) means the desktop's `URLSession` cache will
  honour it for free. Don't add a custom cache layer.

- **Empty-state ambiguity.** A pod that ran validation and
  produced screenshots but had them retention-pruned looks
  identical to a pre-cutover pod that never had any. Both show
  empty. That's fine — the user-facing distinction isn't
  meaningful, and adding a "screenshots were pruned" label
  introduces complexity for no gain.

- **Set scope = single attempt.** Arrow-key navigation should
  scope to ONE validation attempt's screenshots, not across
  attempts. If the validation tab shows multiple attempts
  expanded, each row's thumbnail click opens the lightbox with
  THAT row's refs, not the union. Per `purpose.md` → Glossary:
  "Set — the bag of screenshots from a single validation attempt
  across all three source buckets."

- **Mapper is the URL boundary.** Don't construct URLs in the
  view layer. Build them in the mapper (using the API client's
  base URL). Views consume `URL`, not `String`.

## Wrap-up

1. Build the desktop in Xcode (or
   `xcodebuild -project ... -scheme ...`); resolve any compile
   errors.
2. Run the desktop test target — passes.
3. Run the desktop manually against a real daemon with a recent
   completed pod; verify the manual checks above.
4. Confirm the thumbnail loading state, error state, and
   lightbox arrow-key navigation work as described.
5. Commit and push.

# Desktop village renderer boundary

AutoPod owns fleet data and navigation. The renderer owns appearance and animation.
The desktop's **Village** sidebar destination works with native and managed pods;
it embeds the local `jsonl-animate` village map, sprites, authored walking routes
and work poses. Native pods use recent tool activity; managed pods use smaller
characters and lifecycle state only. The renderer is a pinned snapshot, so work
in the source repository cannot change a running desktop build.

The map occupies the center pane and an accessible native pod list occupies the
right pane. Both show only unfinished pods: `complete` and `killed` are excluded,
and managed attempts with an observed worker exit are excluded even if their
state remains `review_required` or `validated`. Active validation and handoff
stay visible after worker exit. Search filters both.
Selecting a character or list row opens the existing details in the right pane;
**Village pods** returns to the list without clearing the search.

```text
PodStore + EventStream ── native activity ─┐
                                        ├─ VillageSnapshot v1 ─ WKWebView ─ renderer
ManagedPodStore ─────── lifecycle only ───┘                           │
                                                                   select actor
                                                                        │
                                                           existing pod detail panel
```

## Ownership

- `Views/Village/VillageScene.swift`: versioned Codable contract and native/managed
  projections. Namespaced actor IDs prevent collisions. Lifecycle is authoritative;
  a tool result never changes pod state. Recent activity expires after 30 seconds,
  while stage remains the daemon's last known state. No raw reasoning, commands,
  tool output, credentials or API clients are passed to JavaScript.
- `MainView.swift`: shared fleet snapshot/filter state, reduced motion and
  list/detail navigation. `VillagePodListView.swift` renders the native right pane.
- `VillageView.swift`: filter controls, connection state, managed inventory refresh
  every five seconds while visible, and selection callbacks.
  Native activity uses the existing event stream/cache; opening pod details uses
  the existing historical log loader. Unloaded historical activity remains absent.
- `VillageWebView.swift`: bundled document loader, version handshake, coalesced
  snapshots, structured JavaScript arguments, identity-checked selection, timeout,
  error/retry behavior and cleanup. There is no local HTTP server in the app.
- `Resources/Village/host.js`: stable JavaScript bridge. Full snapshots replace
  prior state, including removed actors. Renderer failures surface in native UI.
- `VillageRenderer/`: AutoPod adapter source, styles and live state interpretation.
  This imports upstream drawing, poses and routes without modifying upstream files.
- `Resources/Village/renderer/`: generated, self-contained browser bundle plus
  `upstream/` sources, assets, credits and provenance. Do not edit generated files.

The existing artifact HTML viewer remains separate and still disables JavaScript.
The village permits its bundled scripts, blocks external navigation/network access,
uses a nonpersistent WebKit data store, and never receives daemon authentication.

## Renderer API

Bundle a classic browser script at `renderer/renderer.js`, styles at
`renderer/renderer.css`, and local assets beneath `renderer/`. It registers:

```js
window.AutoPodVillageRenderer = {
  schemaVersion: 1,
  id: 'jsonl-animate-autopod',
  async create({ root, onSelect }) {
    // Load bundled assets and mount a canvas in root.
    return {
      render(snapshot) {
        // Reconcile actors by id. This is current state, not a replay timeline.
        // onSelect(actor.id) opens AutoPod's existing detail panel.
      },
      dispose() {
        // Cancel requestAnimationFrame, observers and listeners.
      },
    };
  },
};
```

`create` may be synchronous or asynchronous. Return `render` and `dispose` after
assets are ready; the host then announces readiness to Swift. `render` is
synchronous and receives immutable JSON values. Do not call native bridges
from the renderer: use `onSelect` only. Unknown IDs are ignored in both JavaScript
and Swift. The host owns error and ready messages.

The desktop root sets `data-pod-list="external"` to hide the renderer's HTML list
and give the map the available height. Other hosts can omit this attribute to
keep the renderer's accessible list. Both paths use the same selection callback.

Snapshot fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `1`; incompatible versions are rejected. |
| `connected` | Desktop daemon connection is available. |
| `activityStreamConnected` | Native pod event stream is connected. |
| `managedDataFresh` | Managed inventory has no current refresh failure and daemon is connected. |
| `reducedMotion` | Native accessibility preference. |
| `selectedActorId` | Optional current selection. May be outside the filtered view. |
| `actors` | Complete, filtered set; missing actors must be removed. |

Each actor has `id`, `podId`, `source` (`native` or `managed`), `detailLevel`
(`activity` or `lifecycle`), `title`, `profile`, `model`, authoritative `status`,
a normalized `stage`, `statusUpdatedAt`, `interactive`, and optional `activity`.
All timestamps are Unix **milliseconds**. IDs are opaque to renderers; the host
currently constructs them as `native:<podId>` or `managed:<podId>`.

Managed actors also carry optional `observedExit` evidence for native filtering;
older v1 snapshots can omit it. This does not change the authoritative status.

An activity contains `kind`, `label`, `eventId`, `observedAt`, and `isRecent`.
It describes an observed tool category, not a claim that the tool is still running
or that a check succeeded. The initial classifier deliberately uses known tool
names; shell commands remain generic command activity. Managed pods always have
lifecycle detail and no invented tool activity. Unknown states map to `unknown`.
Interactive workspaces should not be animated as autonomous agents.

Disconnected sources retain their last known stages, but should stop implying live
work. Honor reduced motion. Render labels as text, not HTML. Animation is cosmetic:
never let an animation queue delay a newly observed failed/waiting/complete state.
Keep display coordinates, stations, sprites and animation clocks inside the renderer.

## Picking up jsonl-animate changes

From the AutoPod repository root (Node 22+):

```sh
npx pnpm install --frozen-lockfile
npx pnpm village:update --source /Users/ewi/repos/jsonl-animate
node --test packages/desktop/Tests/VillageHost/*.test.mjs scripts/update-village-renderer.test.mjs
swift test --package-path packages/desktop --filter Village
```

Pass any local checkout path. The update reads the browser dependency graph and
required assets; it does not modify the source checkout or copy session logs,
server code, credentials, or source node_modules. Local uncommitted changes are
supported: `upstream/provenance.json` records the Git revision, dirty flag and
SHA-256 for every captured file. Files are checked again before accepting the
snapshot; if the source changes during capture, rerun the command. The initial
snapshot was captured from `92b9e0c` with local work in progress. The current
snapshot is the clean `e215d7a` revision, including the v4 Inn map, twelve-species
roster and updated gathering spots. The live adapter chooses species from the
upstream roster by pod ID, so filtering does not reassign characters.

A staged build replaces the generated directory only after imports, metadata and
assets are available. Failed updates preserve the previous working bundle. A
sibling `.lock` directory prevents concurrent updates. If a process is killed,
inspect that directory before removing it; it may contain the previous bundle.
Review the provenance/bundle diff, run the WebKit tests, then rebuild the desktop
app to pick up the new bundle. Nothing is fetched at runtime, and there is no
watcher or symlink to the active renderer checkout.

To rebuild after changing only the AutoPod adapter, omit `--source`. To verify
that checked-in output exactly matches the adapter and pinned upstream snapshot:

```sh
npx pnpm village:update
npx pnpm village:check
```

Both commands work offline after dependencies are installed. esbuild is pinned
in the root lockfile. CI verifies reproducibility, update failure recovery,
semantic mapping and real WebKit asset loading. Upstream API changes fail the
build or WebKit tests; adapt only `VillageRenderer/renderer.mjs` for drawing API
changes and `live-scene.mjs` for AutoPod semantics. The Swift/JavaScript v1 contract
stays separate from those imports.

The live adapter deliberately does not use the upstream replay compiler: replay
condenses time and ends activity after a scene hold, while a pod's lifecycle must
remain authoritative until another daemon observation arrives. Recent activity
expires after 30 seconds, failed/input/complete states interrupt travel, and
stale sources and reduced motion stop the animation loop. Each pod has a stable
character; the accessible list and canvas both select existing pod details.

The bundled artwork is the current local prototype artwork. Supplied per-character
credits, source URLs, PMDCollab CC BY-NC conditions and font OFL notices are preserved
in `renderer/upstream/public/assets/`, including upstream's local-prototype note
for its Red sprite. No new artwork reuse rights are asserted by this integration.

Replay/rewind, helper-agent discovery, managed tool-log collection, the upstream
replay-follow camera and recorded-PR celebrations are not implemented in this
slice. Explicit session-end retirement belongs to the replay compiler; AutoPod
instead removes completed/killed pods using daemon lifecycle state. The live village is an
overview; selecting a pod highlights it and opens its existing details.

## Verification

A fictional cross-language fixture is at
`packages/desktop/Tests/VillageHost/scene.json`. It includes native and managed
pods with the same underlying ID to exercise namespacing. Swift tests compare its
native actor to the real projection; JavaScript tests feed it through the bridge.

```sh
node --test packages/desktop/Tests/VillageHost/*.test.mjs scripts/update-village-renderer.test.mjs
swift test --package-path packages/desktop --filter Village
swift test --package-path packages/desktop
```

Real WebKit tests load the bundled scripts under the page's CSP, exercise the
ready handshake, full snapshot replacement, pre-ready coalescing, managed
selection, stale IDs and text containing script syntax. Desktop CI runs the
Swift suite, JavaScript contract tests and the macOS app build.

### Read-only live connection acceptance test

The optional test below uses the existing CLI login in `~/.autopod/credentials.json`.
Set the URL to your configured daemon. It does not create, launch or modify pods.
If authentication has expired, use the CLI's normal login refresh first.

```sh
AUTOPOD_LIVE_VILLAGE_TEST=1 \
AUTOPOD_LIVE_DAEMON_URL=https://your-configured-daemon \
AUTOPOD_LIVE_VILLAGE_SCREENSHOT=/tmp/autopod-village-live.png \
  swift test --package-path packages/desktop --filter LiveVillageConnectionTests
```

This exercises the actual `DaemonAPI`, paginated `PodStore`/`ManagedPodStore`,
historical `EventStream` decoding, authenticated WebSocket subscription with a
server acknowledgement, `VillageScene` projection, bundled WebKit rendering,
native/managed selection and corresponding detail requests. It reports counts
and stages, not tokens or log contents. The optional screenshot contains real
fleet labels and stays local. Normal test runs skip this suite.

A quiet fleet can prove connectivity and historical log decoding but cannot
prove a newly arriving lifecycle/tool event. The output explicitly reports how
many live events arrived during the observation window; zero is not evidence
of a working live-event transition. This headless test also does not operate
the standalone application's connection setup or sidebar UI.

For an optional screenshot from the actual WebKit test view:

```sh
AUTOPOD_VILLAGE_SCREENSHOT=/tmp/autopod-village.png \
  swift test --package-path packages/desktop --filter VillageWebViewTests
```

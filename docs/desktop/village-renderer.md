# Desktop village renderer boundary

AutoPod owns fleet data and navigation. The renderer owns appearance and animation.
The desktop's **Village** sidebar destination works with native and managed pods;
it currently includes a small stage-board renderer to exercise the integration.
The pixel village from `jsonl-animate` is intentionally **not vendored yet** while
that repository is under active development.

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
- `VillageView.swift`: fleet filters, connection state, reduced motion, managed
  inventory refresh every five seconds while visible, and selection callbacks.
  Native activity uses the existing event stream/cache; opening pod details uses
  the existing historical log loader. Unloaded historical activity remains absent.
- `VillageWebView.swift`: bundled document loader, version handshake, coalesced
  snapshots, structured JavaScript arguments, identity-checked selection, timeout,
  error/retry behavior and cleanup. There is no local HTTP server in the app.
- `Resources/Village/host.js`: stable JavaScript bridge. Full snapshots replace
  prior state, including removed actors. Renderer failures surface in native UI.
- `Resources/Village/renderer/`: replaceable rendering implementation and assets.
  Today this is a reference stage view, with smaller managed characters. It is not
  a fork of `jsonl-animate` and does not prescribe its map, sprites or choreography.

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

1. Select a reviewed renderer revision when ready. Do not symlink to or watch the
   in-progress checkout and do not add it as a runtime dependency.
2. In `renderer/`, add a small adapter implementing the interface above. Bundle
   the renderer's browser modules to `renderer.js` and copy its required assets.
   Keep source revision and build instructions with that bundle. The adapter maps
   semantic pod state onto whatever renderer API that revision exposes.
3. Leave Swift projections and `host.js` unchanged for renderer-only changes.
   New optional scene fields can be additive; incompatible semantics require an
   explicit contract version bump in both sides.
4. Run the shared fixture and WebKit checks below. Validate asset paths in the
   actual app bundle, which copies the entire `Village/` directory.

The current jsonl-animate replay compiler condenses time and ends activity after a
scene's hold duration. A live renderer adapter must maintain current pod state
independently of that replay clock. Live scene rendering and saved-session replay
can share drawing code without sharing their scheduling assumptions.

This first slice does not implement replay/rewind, helper-agent discovery, managed
tool-log collection, renderer hot reload, or the final pixel artwork. Those can be
added without coupling the desktop to the active renderer checkout.

## Verification

A fictional cross-language fixture is at
`packages/desktop/Tests/VillageHost/scene.json`. It includes native and managed
pods with the same underlying ID to exercise namespacing. Swift tests compare its
native actor to the real projection; JavaScript tests feed it through the bridge.

```sh
node --test packages/desktop/Tests/VillageHost/host.test.mjs
swift test --package-path packages/desktop --filter Village
swift test --package-path packages/desktop
```

Real WebKit tests load the bundled scripts under the page's CSP, exercise the
ready handshake, full snapshot replacement, pre-ready coalescing, managed
selection, stale IDs and text containing script syntax. Desktop CI runs the
Swift suite, JavaScript contract tests and the macOS app build.

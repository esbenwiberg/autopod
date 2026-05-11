---
title: "Add runningAt timestamp to Pod and use it as the ArtifactsTab filter pivot"
touches:
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/desktop/Sources/AutopodClient/Types/PodResponse.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ArtifactsTab.swift
  - packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift
does_not_touch:
  - packages/daemon/src/pods/state-machine.ts
  - packages/desktop/Sources/AutopodUI/Models/MockData.swift
---

## Task

Add a `runningAt` timestamp to the `Pod` type that is set exactly once — when the pod
transitions to `running` status for the first time in a provisioning run. Propagate the
field through the daemon API and all Swift layers, then use it as the pivot in
`ArtifactsTab` to filter out files that predate the agent's execution (i.e. the git-cloned
repo tree). The existing `showAllFiles` toggle stays; only the filter's reference point
changes.

## Why

The `ArtifactsTab` already has a `showAllFiles` toggle that is supposed to hide
pre-existing files. The pivot it uses is `pod.startedAt`, which marks when the pod entered
`provisioning` — before the container boots and clones the repo. Because the git clone
happens ~20–30 s later, all cloned files carry a `mtime` that is still ≥ `startedAt`, so
the filter passes everything and the toggle has no effect. Using `runningAt` (the moment
the agent actually starts) as the pivot means the clone lands before it and the filter
works as intended.

## Touches

- `packages/shared/src/types/pod.ts` — add `runningAt: string | null` to the `Pod`
  interface and to the `PodUpdates` partial interface.
- `packages/daemon/src/db/migrations/098_pod_running_at.sql` — new migration:
  `ALTER TABLE pods ADD COLUMN running_at TEXT;`
- `packages/daemon/src/pods/pod-repository.ts` — map `running_at` in `rowToSession()`
  and handle `changes.runningAt` in `updateStatus()` / `update()`.
- `packages/daemon/src/pods/pod-manager.ts` — pass `runningAt: new Date().toISOString()`
  in the **one** initial `transition(pod, 'running', {...})` call at line ~3774 (inside
  the main provisioning path, right after the container starts).
- `packages/desktop/Sources/AutopodClient/Types/PodResponse.swift` — add
  `public let runningAt: String?` and include `runningAt` in the `CodingKeys` enum.
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift` — map
  `response.runningAt` to `pod.runningAt` using the existing `parseDate` helper (returns
  `nil` when `response.runningAt` is `nil`; do not fall back here — let the view handle
  the fallback).
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift` — add `public var runningAt: Date?`
  to the `Pod` struct and wire it through the primary `init` parameter list.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ArtifactsTab.swift` — change the
  `filteredFiles` pivot from `pod.startedAt` to `pod.runningAt ?? pod.startedAt`. Update
  the toggle help text from "Disable the modified-since-pod-started filter" to "Disable
  the modified-since-agent-started filter".
- `packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift` — update the existing
  `mapsRunningSession` test to include `"runningAt"` in the JSON fixture and assert the
  mapped `pod.runningAt` is the expected `Date`. Add a second test asserting that a
  response with `null` / missing `runningAt` maps to `pod.runningAt == nil`.

## Does not touch

- `packages/daemon/src/pods/state-machine.ts` — no new state or transition is being added.
- `packages/desktop/Sources/AutopodUI/Models/MockData.swift` — `runningAt` is optional
  and the fallback in `ArtifactsTab` handles `nil` gracefully; mock data does not need
  updating.

## Constraints

**Migration prefix.** The highest existing prefix is `097` (`097_pod_last_recovery_trigger.sql`).
The next migration must be `098_pod_running_at.sql`. A `PreToolUse` hook blocks writes that
collide on prefix — do not reuse 097. From CLAUDE.md: *"Never reuse a number."*

**Only the initial running transition gets runningAt.** `pod-manager.ts` contains multiple
`transition(pod, 'running', {...})` calls:
- Line ~3774: the **main provisioning path** — add `runningAt: new Date().toISOString()` here.
- Lines ~5172, ~5204, ~5224, ~5252, ~5703: resume-from-escalation / resume-from-paused paths —
  do **not** add `runningAt` here; the field is already set from the initial run and the
  repository update ignores keys absent from `changes`.

Recovery/rework pods (`isRecovery = true`) also go through line ~3774 — that is intentional.
A rework is a fresh agent run; resetting `runningAt` to the new run's start time is correct.

**Backward compatibility fallback.** Pods created before this migration will have
`running_at = NULL` in the DB and `runningAt = nil` in Swift. `ArtifactsTab` must fall
back: `pod.runningAt ?? pod.startedAt`. Do not make `runningAt` non-optional in the Swift
model.

**No other UI surfaces.** `runningAt` is plumbing for the filter pivot. Do not display it
in the pod detail header, the overview tab, or anywhere else.

**Serialization is automatic.** The daemon returns `Pod` objects serialized directly to
JSON by Fastify. Adding `runningAt` to the `Pod` type and mapping it in `rowToSession()`
is sufficient — no route handler changes needed.

## Skills to reference

None.

## Test expectations

**`PodMapperTests.swift`** (extend the existing Swift test file):
- *Happy path*: fixture JSON with `"runningAt": "2026-04-01T09:00:35Z"` → `pod.runningAt`
  equals that `Date`. The `filteredFiles` pivot should resolve to `runningAt` (not
  `startedAt`) when `runningAt` is non-nil.
- *Null runningAt*: fixture JSON with `"runningAt": null` → `pod.runningAt == nil`. When
  `ArtifactsTab` uses `pod.runningAt ?? pod.startedAt`, it falls back to `startedAt`.
- *Missing runningAt key*: fixture JSON omitting the `"runningAt"` key entirely → decodes
  without error, `pod.runningAt == nil`.

**Daemon unit tests** — add to the existing `pod-repository.test.ts` (or the closest
applicable test file in `packages/daemon/src/pods/`):
- *Sets runningAt on initial running transition*: create a pod, call `update()` with
  `{ runningAt: '2026-04-01T09:00:35.000Z' }`, re-fetch, assert `pod.runningAt` matches.
- *Does not overwrite runningAt on subsequent update*: after setting it, call `update()`
  again without `runningAt` in `changes`, re-fetch, assert value is unchanged.

## Risks / pitfalls

**3-package span.** This brief touches `shared`, `daemon`, and `desktop`. Per the
`/prep` skill rules this warrants a `/plan-feature`; the user accepted the `/prep` format
with the risk noted here. If the agent finds itself needing to make architectural decisions
not covered by this brief, it should stop and escalate rather than invent.

**Explicit CodingKeys in PodResponse.swift.** The Swift `PodResponse` struct has a full
`CodingKeys` enum. Adding `runningAt` to the struct **without** adding it to `CodingKeys`
will silently fail to decode (the property will always be `nil`). Add `runningAt` to the
enum (line ~148 in `PodResponse.swift`).

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.

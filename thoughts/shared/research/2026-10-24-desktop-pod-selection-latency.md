---
date: 2026-10-24T21:35:33+02:00
timezone: Europe/Copenhagen
researcher: Codex
git_commit: 4c98ab935cb5100968a62e6d431e95f890700a5f
branch: ""
head_state: detached
repository: autopod
topic: "Desktop pod selection and detail-tab latency: current rendering, state, and request paths"
tags: [research, codebase, desktop, swiftui, performance]
status: complete
last_updated: 2026-10-24
last_updated_by: Codex
---

# Research: desktop pod selection and detail-tab latency

## Research Question

The user reports that selecting a pod or a tab in the redesigned desktop app takes several seconds. What current source paths participate in these interactions, what did the live investigation observe, and what behavior and verification infrastructure already exist?

This is the Research phase of the requested RPI workflow. It records current behavior and evidence; it does not choose an implementation. No issue-tracker ticket was supplied. The checkout was clean at the start of this phase. `git branch --show-current` returned an empty string and `git rev-parse --abbrev-ref HEAD` returned `HEAD`; this checkout is detached at the commit above.

## Summary

Pod selection writes a binding immediately, and detail-tab buttons assign their selection binding directly. Selection-related network operations are scheduled asynchronously. Rendering also executes fleet-wide calculations: `MainView` computes repository identities, picker options, filtered/sorted visible pods, and repository-filtered archive totals as computed properties and view-building expressions. These calculations have no retained result in `MainView` (`MainView.swift:351`, `395`, `673`, `1128`, `1134`, `1574`).

The preceding live investigation exercised the installed app with 957 loaded pods. Mouse interactions produced multi-second click-to-observation intervals. Two native stack samples contain main-thread call paths through SwiftUI constraint/layout evaluation, `MainView.body`, repository-option construction, repository URL parsing, and fleet filtering. These observations establish that the work executes during the sampled sessions. They do not quantify its share of an individual stall or establish a single cause for the approximately 11-second outlier.

There are also two selection-driven historical-event load call sites. Hydration has completed/in-flight admission checks; historical-event loading explicitly always refetches. Existing tests cover repository identity, archive visibility, hydration, tab fallback, and mounted section navigation. The inspected native tests do not measure top-level pod/tab interaction latency.

## Detailed Findings

### 1. Selection ownership and detail navigation

- `AppRootView` binds `MainView.selectedSessionId` to `PodStore.selectedSessionId`; the setter only assigns the ID (`packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift:117`).
- Redesigned cards set `selectedSessionId` in `onTapGesture`; list mode binds its selection to the same property (`packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1523`, `1563`).
- `MainView` owns both `selectedDetailTab` and `requestedDetailTab` as `@State` and passes their bindings into `DetailPanelView` (`MainView.swift:351`, `1107`). The tab buttons assign `selectedTab` synchronously (`packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1831`).
- The native detail is keyed with `.id(pod.id)` (`MainView.swift:1111`). The panel chooses content with `switch activeTab`; ordinary tab content is conditional, while an available Terminal view stays mounted with opacity/hit-testing controlled by selection (`DetailPanelView.swift:324`, `382`).
- A valid current tab survives a pod change. Invalid Series/Terminal/Evidence selections fall back to the pod's default. Artifact output defaults to Evidence; other pods default to Overview (`DetailPanelView.swift:181`, `188`, `202`). `onAppear` and pod/request changes reconcile these bindings (`DetailPanelView.swift:288`, `404`).
- Explicit navigation from analytics/history/schedules/series routes through `openFleetPod`. It clears search/repository filters, selects All pods, selects the target, and can set both selected/requested detail tabs (`MainView.swift:1607`). Terminal attachment separately requests Terminal, including a main-queue turn when changing pods (`MainView.swift:378`).

The source locates selection state and its consumers. No isolated state-write experiment was performed to count how many parent/fleet renders a tab assignment alone causes while daemon events are absent.

### 2. Repository derivation and environment data

`DesktopRepository` parses and normalizes a remote URL using `URLComponents`, accepts HTTP/HTTPS/SSH/git transports, handles scp-style SSH syntax, removes `.git`, and forms an identity from host and path. Its display label excludes credentials/query/fragment (`packages/desktop/Sources/AutopodUI/Models/DesktopPresentation.swift:10`).

Resolution has an ordered source of truth (`DesktopPresentation.swift:28`):

1. Modern `fleetDisplay.repository`, when present. Explicit `empty`/`unavailable` returns no repository and does not fall through.
2. The captured `profileSnapshot` repository.
3. A matching mutable profile for legacy pods; this result has `isSnapshot == false`.

`MainView.repositoriesByPod` resolves every loaded pod each time the getter executes. It does not restrict this pass to visible cards (`MainView.swift:1128`). `MainView.body` supplies this dictionary through `desktopRepositories` (`MainView.swift:673`; environment declaration: `packages/desktop/Sources/AutopodUI/Views/Shared/DesktopTheme.swift:25`). Both cards and the detail panel read that environment (`packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift:59`; `DetailPanelView.swift:25`).

`MainView.repositories` evaluates `repositoriesByPod` once to obtain distinct IDs, then reevaluates that getter within `compactMap` for each distinct ID before sorting the labels (`MainView.swift:1134`). At the source level, one evaluation of `repositories` performs one full mapping pass plus one full mapping pass per distinct repository. The redesigned toolbar reads `repositories` for its subtitle and picker (`MainView.swift:1146`, `1176`). These are computed getters, without a stored snapshot or invalidation key.

The archive footer computes its repository-scoped total as `pods.filter { repositoriesByPod[$0.id]?.id == id }.count` when a repository is selected (`MainView.swift:1576`). The full dictionary getter is therefore inside the per-pod predicate. The local total is computed before the subsequent sidebar/recent/query visibility condition. This expression was verified in source; a repository-filtered footer was not exercised in the earlier live measurements.

### 3. Fleet filtering, sorting, and card construction

- `filteredSessions` invokes `visiblePods` afresh on each access (`MainView.swift:395`).
- Repository filtering resolves each candidate's repository before selecting a sidebar scope or applying the recent cap (`MainView.swift:444`).
- With All pods, Recent, and an empty query, `recentBrowsePods` retains actionable non-workspace pods, sorts other pods by recent activity, and fills the remaining places up to the default limit of 50. A directly selected archived pod can add one row beyond that cap (`MainView.swift:424`, `470`). This limits displayed membership, not the size of the loaded input or repository mapping.
- A nonempty search uses the full scoped archive; its fields include repository label, pod ID, brief title, task, profile, and series name (`MainView.swift:410`). The final visible set is sorted by created/last-active order (`MainView.swift:493`).
- The redesigned toolbar reads `filteredSessions.count` twice. The grid separately reads it for empty-state handling, attention/recent grouping, and the footer count (`MainView.swift:1146`, `1480`, `1498`).
- The grid uses `LazyVGrid` inside a `ScrollView`; group/filter calculations occur outside the individual lazy cards (`MainView.swift:1498`, `1519`). Cards also have hover/selection animations of 0.15 seconds (`PodCardFinal.swift:134`).

### 4. Selection-related requests and main-actor publication

`MainView.onChange(of: selectedSessionId)` invokes `onSelectSession` (`MainView.swift:759`). Its `AppRootView` closure schedules subscription changes, a hydration task, a diff task, and historical-event loading (`AppRootView.swift:174`). Independently, `AppRootView.task(id: selectedSessionId)` handles initial mounting and subsequent changes, calls hydration, then requests historical events (`AppRootView.swift:339`).

The request/cache behavior differs by resource:

| Resource | Current behavior | Source |
| --- | --- | --- |
| Full pod | Hydration checks completed and in-flight ID sets; later compact data can invalidate completed hydration. | `packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift:257`, `381` |
| Diff | Responses are retained by ID, but `loadDiff` itself always requests; it has no cache-read/in-flight guard. Empty responses remove the retained value. | `PodStore.swift:420` |
| Historical events | `loadHistoricalEvents` explicitly always refetches, publishes `.loading`, and creates a task. Both selection paths can call it. It has no completed/in-flight guard. | `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift:186` |

`DaemonAPI` is an actor. It awaits `URLSession.data(for:)` and then decodes the response in the API actor (`packages/desktop/Sources/AutopodClient/DaemonAPI.swift:6`, `1144`, `1156`). There is no synchronous network wait in the selection setter or tab-button action.

After a full-pod response, `PodStore` maps and revision-merges it, searches for its index, and writes the updated pod on `MainActor` (`PodStore.swift:6`, `352`). Historical events are mapped, merged, and published on the main actor (`EventStream.swift:27`, `225`). The default historical limit is 300 (`EventStream.swift:74`). The earlier live session did not record request counts, payload sizes, or timings, so it does not establish how many historical loads actually completed during a particular interaction.

### 5. Live updates and observation boundaries

`PodStore` publishes its fleet as a single observable `[Pod]` property; `AppRootView.body` reads this array and the diff dictionary when constructing `MainView` (`PodStore.swift:6`; `AppRootView.swift:105`, `162`). `EventStream` similarly has observable dictionaries for events and history state (`EventStream.swift:53`). The selected-events accessor subscripts this dictionary (`AppRootView.swift:79`); its comment expresses the intent to avoid unrelated invalidations, but there is no separately observable per-pod storage object in that accessor.

WebSocket callbacks explicitly enter `MainActor` (`EventStream.swift:122`). Event-buffer publication is batched after a 100 ms sleep, with 500 global events and 300 per-pod events except fully loaded history (`EventStream.swift:503`, `512`). Overview-worthy activity still updates pod activity immediately (`EventStream.swift:426`). Exact cross-key view invalidation frequency and event arrival rates were not measured.

### 6. Recorded live observations and stack samples

These observations were made earlier in this same conversation, on 2026-10-24, using the Computer Use tool against `/Applications/Autopod.app`. The UI showed 957 loaded pods, an Active view of 5 pods, and All pods/Recent showing 50. The initially selected pod was `necessary-gecko` on Overview. That selection/view/tab was restored after the investigation.

| Interaction | Click through next accessibility observation |
| --- | ---: |
| Active: Readiness on `necessary-gecko` | 693 ms |
| Active: select `select-pinniped` while on Readiness | 1,157 ms |
| Active: Work, then Overview on `select-pinniped` | 893 ms; 945 ms |
| All pods/Recent: mouse-select `sunny-whitefish` | 2,134 ms |
| Mouse-select Logs on `sunny-whitefish` | 868 ms |
| Diff, then Validation on `sunny-whitefish` | 1,160 ms; 1,040 ms |
| Mouse-select `reasonable-guan` while on Validation | 11,028 ms |
| During the second profiling session: mouse-select `select-pinniped` | 3,438 ms |
| During the second profiling session: mouse-select Work, then Overview | 2,897 ms; 2,442 ms |
| Back in Active: mouse-select Work on `select-pinniped` | 1,844 ms |

These are `Date.now()` intervals around tool `click` plus `getAXState`, not native input-to-frame measurements. They include tool routing, input dispatch, accessibility stabilization/tree retrieval, and any concurrent profiler overhead. They are not a latency distribution or a verified app-only 11-second main-thread freeze. Accessibility-targeted and coordinate-targeted clicks are mixed as noted. The user has not supplied manual verification of a changed build.

The installed process was PID 9649, version 0.1.0 (1), ARM64, on macOS 27.0.1 (26A434), launched 2026-10-23 13:11:37 +0200. No embedded source commit was recorded for the installed binary. Its sampled source symbols/line numbers align with the current paths, but exact binary/checkout revision equivalence is unverified.

Two raw local samples exist outside the repository:

| Capture | Local path | SHA-256 |
| --- | --- | --- |
| 20 seconds, requested 1 ms sample interval; started 21:26:39.112 +0200 | `/private/tmp/autopod-ui-selection-sample.txt` | `6b104b46cd68822a9882c7aba4f3e36aae07b8ddcaa874c7c78b28a71e6c3176` |
| 30 seconds, requested 2 ms sample interval; started 21:27:14.289 +0200 | `/private/tmp/autopod-ui-selection-sample-2.txt` | `c531ffd1a91f038fdedebb7f3921378a4c740ee89652b82f0ce04fe4f5a5547b` |

Representative entries from the second sample, preserved here so the next phase does not depend on temporary files:

```text
line 81:  407 NSHostingView.minSize()                         (SwiftUI)
line 96:  351 MainView.body.getter                           MainView.swift:633
line 99:  350 closure #2 in MainView.podNavigation.getter     MainView.swift:925
line 102: 240 MainView.contentToolbar.getter                 MainView.swift:1125
line 106:  95 MainView.repositories.getter                    MainView.swift:1135
line 107:  87 MainView.repositoriesByPod.getter               MainView.swift:1129
```

These entries lie on a main-thread constraint/layout evaluation branch leading into repository URL construction. Both samples also contain `MainView.filteredSessions.getter` and `DesktopRepository.init(url:isSnapshot:)`. The sample counts above are hierarchical inclusive counts, not durations or independent totals; they must not be summed as a percentage attribution. The captures include idle/run-loop waiting as well as active work. No per-click trace marker correlates an individual stall with its exact stack interval.

### 7. Existing tests and verification boundaries

The following source/test claims were inspected, not rerun in this Research phase:

| Coverage | Existing assertions and boundary |
| --- | --- |
| Repository presentation | `packages/desktop/Tests/AutopodUITests/DesktopPresentationTests.swift:13`, `22`, `33`, `46`, `73`: safe display identity; snapshot/modern precedence; explicit empty/unavailable; repository filtering before cap; repository-label search. |
| Archive/navigation | `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift:89`, `108`, `125`, `143`, `155`: recent cap/actionable retention; search across archive; directly selected archived row; full archive; explicit navigation destination. `packages/desktop/Tests/AutopodUITests/FleetPodNavigationTests.swift:5` covers reveal across search/repository filters. |
| Detail tabs | `packages/desktop/Tests/AutopodUITests/DetailPanelTabSelectionTests.swift:22`, `35`, `48`, `61`, `67`: Diff preservation, fallback for unavailable tabs, and default tabs. These call selection helpers without a containing fleet render. |
| Mounted detail sections | `packages/desktop/Tests/AutopodUITests/DetailSectionNavigationTests.swift:7`: real Work/Evidence/Validation layout and section interaction, at 680/1400-point widths and light/dark. Top-level selected tabs are constant bindings. |
| Fleet hydration | `packages/desktop/Tests/AutopodClientTests/PodStoreFleetTests.swift:145`, `190`: initial hydration once, rehydration after newer compact data, captured repository display surviving hydration/refresh, and null progress clearing an older milestone. |

The existing `LaunchComposerHost` uses a real `NSWindow`/`NSHostingView`, accessibility traversal/actions, forced layout, and optional PNG capture. It disables animations and polls for completion every 20 ms with a five-second deadline (`packages/desktop/Tests/AutopodUITests/LaunchComposerTests.swift:359`, `367`, `374`, `398`). That deadline is functional completion coverage, not a recorded responsiveness metric. No native pod/tab timing threshold, rendering-cost counter, or measured whole-`MainView` interaction benchmark was found in the inspected desktop tests and scripts.

The canonical full desktop test command is `./scripts/test-desktop.sh`; it discovers the Swift test inventory and runs each target in a separate process with `--no-parallel` (`scripts/test-desktop.sh:13`, `20`; rationale in `docs/desktop/test-isolation.md`). The Swift package requires tools 6.0 and targets macOS 15+ (`packages/desktop/Package.swift:1`). A separate signed Debug Preview build is available through `scripts/build-desktop-preview.sh`; its bundle ID and output path differ from the installed app (`scripts/build-desktop-preview.sh:13`). No build, installation, or test command was run during this Research phase.

## Code References

- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:351` — parent-owned detail-tab state.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:395` — visible-fleet recomputation entry.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:673` — repository dictionary injected into the environment.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1074` — detail input/binding construction and pod identity.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1128` — all-loaded-pod repository mapping.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1134` — repository-option derivation.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1498` — redesigned lazy grid and repeated grouping inputs.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1576` — repository-scoped footer total.
- `packages/desktop/Sources/AutopodUI/Models/DesktopPresentation.swift:28` — repository-source precedence.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1831` — top-level tab action.
- `packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift:174` and `:339` — selection load entry points.
- `packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift:381` — hydration admission.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift:189` — historical-event load admission behavior.

## Architecture Documentation

The desktop has three separate layers: `AutopodClient` for actor-isolated API transport, `AutopodDesktop` for main-actor observable stores and application bridging, and `AutopodUI` for views and presentation helpers (`packages/desktop/Package.swift`). `AppRootView` supplies value arrays, dictionaries, selection bindings, and closures to the UI. `MainView` contains fleet navigation and selection state; `DetailPanelView` consumes pod/event values and the parent-owned tab bindings. Repository display is shared through a SwiftUI environment dictionary. The native package and Xcode app have their own build/test path outside the pnpm workspace (`AGENTS.md`, desktop section).

## Historical Context

- `git blame` attributes `MainView.repositoriesByPod` and `repositories` to commit `6a7eb2539` (2026-10-16T22:34:59+02:00), titled `desktop: implement themed fleet and overview redesign`. This dates these source expressions; it does not date the first user-visible stall.
- Later commits include `7151cc66` (2026-10-18), `fix(desktop): reveal explicitly opened pods across fleet filters`, and `bb2abff1` (2026-10-19), `fix(desktop): preserve captured repository and milestones in fleet discovery`. Current navigation and repository precedence tests reflect those behaviors.

## Related Research

`thoughts/shared/research/2026-10-15-fleet-performance-boundary.md` documents the earlier compact-list/desktop-loading boundary and explicitly distinguishes bounded payloads from a UI latency distribution. It predates the repository getters above. Its historical line references and unmeasured latency statement are not substituted for the current source and live observations in this report.

## Open Questions

1. How much of an individual click interval is native UI/layout work versus tool observation overhead, response publication, and other concurrent work? The current samples do not provide per-interaction attribution, and no before/after controlled measurement exists.
2. What exact source revision/configuration produced the installed binary? Version, process identity, symbol paths, and launch time were recorded; an embedded Git revision was not.
3. How often do unrelated event/diff updates invalidate the rendered fleet, and how many historical requests actually occur for a selection? Current source exposes shared observable properties and two call sites; runtime counts were not captured.
4. No product latency acceptance threshold has been supplied or selected. That remains a Plan-phase decision, not a measured current guarantee.

## Phase State and Next Action

Research is complete for the current-state question. Source, relevant tests, repository history, and the two existing stack captures were inspected. Two bounded research agents returned selection/request-flow and test/build findings; load-bearing paths were checked in the main conversation. Product code, tests, app installation, and daemon state were not changed in this phase. No plan is approved. No tests or manual acceptance checks are reported as passing.

`hack/spec_metadata.sh` is absent; metadata came from read-only Git and the Europe/Copenhagen clock. The HumanLayer CLI is present, but no configured Thoughts sync for this checkout was established, so no sync was attempted. No explicit compaction capability is available in this session.

The exact next workflow action is to enter Plan: read `/Users/ewi/.codex/skills/rpi/references/plan.md` completely, reload this artifact, and recheck the relevant live source. Select measurement boundaries, acceptance criteria, scope, and implementation details during that phase. Implementation requires the user's explicit approval of that plan.

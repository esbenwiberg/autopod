---
date: 2026-10-24T21:49:08+02:00
timezone: Europe/Copenhagen
author: Codex
git_commit: 4c98ab935cb5100968a62e6d431e95f890700a5f
branch: ""
head_state: detached
status: desktop_released_daemon_recovery_fix_approved
structure_approved: true
implementation_approved: true
research: thoughts/shared/research/2026-10-24-desktop-pod-selection-latency.md
---

# Desktop Pod Selection Latency Implementation Plan

## Overview

Make pod selection and cached detail-tab switching responsive in the redesigned native desktop app. Measure a reproducible 1,000-pod workload, remove repeated repository and fleet derivation, isolate detail navigation state, remove the duplicate selection-triggered historical-log request, then verify the native result and the actual UI.

The user approved the proposed Measure → Fix → Verify structure and the target that 95% of cached selections and tab switches respond within 250 ms by saying “go on” after those choices were presented. This authorizes preparation of this detailed plan. It is not approval to implement it.

## Current State Analysis

The research artifact is the authoritative evidence record. The relevant source was rechecked during planning at the commit above; the only preexisting worktree addition was that research artifact.

- `MainView.repositoriesByPod` resolves every loaded pod each time its computed getter is read. `repositories` invokes that full getter again for each distinct repository (`packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:1128`, `1134`).
- The repository-filtered footer invokes the full mapping getter inside a per-pod filter, before checking whether the footer is visible (`MainView.swift:1574`).
- Toolbar, grid groups, empty state, and footer independently read `filteredSessions`; each read filters and sorts again (`MainView.swift:395`, `1146`, `1498`).
- Selected/requested detail tabs are `MainView` state passed down as bindings. Programmatic navigation also writes these fields (`MainView.swift:351`, `378`, `1107`, `1607`).
- Detail-tab buttons change their bindings immediately. Valid tabs survive pod changes; defaults and unavailable-tab fallback are explicit. Terminal stays mounted across tab changes (`packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:181`, `202`, `324`, `382`, `1831`).
- Both the selection callback and the selected-ID `.task` request history. Hydration has admission checks, while historical loading explicitly always refetches (`packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift:174`, `339`; `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift:186`; `packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift:381`).
- API transport is asynchronous. Response mapping/publication and event updates share the main actor with UI work. The research samples establish execution paths, not per-click causal attribution.
- Existing native tests cover functionality and layout. They do not measure the complete mounted fleet/detail interaction. The prior computer-use intervals include observation overhead and cannot serve as the 250 ms benchmark.

## Desired End State

1. A reproducible native harness measures the actual mounted `MainView` with 1,000 loaded pods. Every measured cached pod-selection/tab-switch case has p95 ≤ 250 ms on the user's Mac using the fixed Release configuration below.
2. Selection acknowledgement and cached content layout do not wait for network completion. A pending request can leave a loading state while the newly selected pod/tab is already shown.
3. Repository mapping, picker options, repository counts, and visible-fleet grouping reuse the same derived values. Unchanged repository inputs do not repeat URL normalization.
4. A normal detail-tab change does not write selection state owned by the fleet view. Parent updates can still occur for real pod/event changes.
5. One selected-pod history owner handles initial appearance and subsequent selection changes. Reload, full-history, related-pod, and resync behavior retain their existing meanings.
6. Existing repository identity, search/archive membership, tab fallback, terminal lifetime, and explicit-navigation behavior remain covered.

### Key Discoveries

- The repository dictionary is injected through `desktopRepositories` and used by both cards and detail. It must have the same source precedence everywhere (`MainView.swift:673`; `packages/desktop/Sources/AutopodUI/Models/DesktopPresentation.swift:28`).
- Modern explicit empty/unavailable repositories must not fall back to a mutable profile. Captured identity beats mutable configuration.
- A recent view of 50 cards can still perform calculations over all 1,000 loaded pods. Reducing visible membership is not a substitute for fixing repeated derivation.
- `LaunchComposerHost` provides a native window/AX pattern, but disables animations and uses a five-second completion poll. Its timeout is not a latency metric (`packages/desktop/Tests/AutopodUITests/LaunchComposerTests.swift:359`).
- `scripts/build-desktop-preview.sh --fixtures` provides a separate signed Preview app and fixture mode. `DesktopDesignPreview` already has a fixture-options menu (`packages/desktop/Sources/AutopodDesktop/Views/DesktopDesignPreview.swift`).

## What We're NOT Doing

- No daemon/API/schema changes, migrations, pagination redesign, provider work, or pod lifecycle changes.
- No UI redesign, reduction of the loaded archive, removal of searchable fields, debounce that delays clicks, or hiding stale data behind a timer.
- No persistent/global cache of whole pods, whole-pod hashing/equality, custom view equality that ignores closures, or general replacement of store observation.
- No general EventStream caching/lifetime rewrite, diff-fetch policy change, subscription rewrite, or unrelated connection fixes. Remove the identified duplicate history call without changing history refresh semantics.
- No deployment, replacement of `/Applications/Autopod.app`, credential migration, commit, push, PR, or issue-tracker action.

## Implementation Approach

### Shared repository index and one fleet presentation per body evaluation

Add an internal main-actor `DesktopRepositoryIndexCache` and immutable `DesktopRepositoryIndex` in `packages/desktop/Sources/AutopodUI/Models/DesktopFleetPresentation.swift`.

- `DesktopRepositoryIndex` contains `byPodID`, stable unique `repositories`, and `countsByRepositoryID`.
- The cache is a plain, nonobservable reference retained in `MainView` with `@State`. Its memoized storage must not publish SwiftUI changes during body evaluation.
- Extract each pod's repository source using the existing precedence, represented as a small equatable source key: pod ID, source kind, raw remote or explicit empty/unavailable, and captured/legacy flag. Build a name-to-profile lookup once, retaining first-match semantics. Only a changed source is normalized again.
- Keep extraction and parsing under one source-of-truth implementation with `DesktopRepository.resolve`; extend `DesktopPresentation.swift` with an internal source representation rather than creating a second independently maintained precedence chain.
- Prune removed pod IDs on refresh. Membership/source changes rebuild the aggregate map/options/counts once. Unchanged source keys reuse the previous index even if unrelated activity, token, or event values change.
- Preserve per-pod `isSnapshot` and current label sorting. For duplicate identities in picker options, choose the first occurrence in current pod order; do not depend on dictionary iteration order. Do not log raw source keys or remotes.

Add `DesktopFleetPresentation` in the same file. It contains current visible `[Pod]`, attention/remainder groups, visible count, and scoped archive total. Build it once per `MainView.body` evaluation from current pod values, current filters, and the index. Pass that value into toolbar/content/grid/footer builders instead of recomputing it through multiple getters. Do not retain visible `[Pod]` across updates: current activity, readiness, and control state must remain fresh.

Extend existing `MainView.visiblePods` and `searchPods` with an optional precomputed repository index. Preserve default calling behavior for existing tests and command-palette callers. With an index supplied, repository matching and label search use lookups rather than URL parsing. Preserve filter order, recent selection escape, archive behavior, and sort semantics. Footer totals use the precomputed count, without a nested mapping pass.

Small in-memory key scans remain O(N); URL parsing is limited to changed sources, aggregate index construction is one pass plus repository-label sorting, and visible-fleet filtering/sorting runs once per body evaluation. This is intentionally narrower than caching an entire fleet view or changing its observable storage.

### Detail-owned observation

Add internal `@Observable @MainActor DesktopDetailNavigation` in `packages/desktop/Sources/AutopodUI/Models/DesktopDetailNavigation.swift`, with `selectedTab` and `requestedTab` properties and `request(_ tab: DetailTab)` for explicit navigation.

`MainView` retains this object with `@State` and passes it without reading its tab properties. A small `DesktopDetailNavigationHost<Content: View>` in `packages/desktop/Sources/AutopodUI/Views/Detail/DesktopDetailNavigationHost.swift` observes it and supplies the two bindings to the existing `DetailPanelView` initializer. Keep `DetailPanelView`'s public binding API and selection helpers.

Replace all `MainView` writes to the former state fields, including `openFleetPod` and terminal attachment, with writes/requests on the navigation object. Preserve the current deferred terminal request when switching pods. Keep `.id(pod.id)` around the keyed detail subtree while retaining the navigation object outside that identity, so a valid selected tab continues across pods. Do not add eager construction of every tab.

### One selected-pod history owner

Extract the existing selected-ID `.task` into an internal `SelectedPodHistoryLoader: ViewModifier` in `packages/desktop/Sources/AutopodDesktop/Views/SelectedPodHistoryLoader.swift`. It receives the selected ID, API, `PodStore`, and optional `EventStream`; it performs the existing hydration/history sequence on mount and selection changes. Check task cancellation after the hydration await before starting history.

Use this modifier in `AppRootView`. Remove only the historical-load call from `onSelectSession`; retain that callback's existing subscription, hydration, and diff behavior. This extraction makes the production history lifecycle mountable with the existing held-REST fixture, without changing `ConnectionManager` or touching saved connections in tests.

Do not add a loaded/in-flight guard to `EventStream.loadHistoricalEvents`. Returning to a pod, explicit reload, full-history requests, related-pod loading, and resync continue to request history as before. Source-owner cancellation prevents dispatching a new historical load for a superseded selection after hydration; already dispatched EventStream requests keep their existing semantics.

## Phase 1: Reproducible Native Baseline

### Overview

Establish the measurement code before altering the rendering/request paths. Capture the current checkout with the same workload and harness used after the fix. The unknown installed-binary revision is not used as a numerical before/after baseline.

### Changes Required

#### 1. Deterministic fleet fixture

**New file:** `packages/desktop/Sources/AutopodUI/Models/DesktopPerformanceFixtures.swift`.

Provide a reusable synthetic fixture for tests and explicit design-preview mode: exactly 1,000 unique pods, ten repositories of 100 pods each, ten actionable non-workspace pods (five running/five validated), and 990 completed pods. Use fixed timestamps, unique short titles, representative 2,000-character tasks, and cached 300-event streams for the measured targets. Provide small deterministic cached diff, validation, and evidence values/loaders. Disable previews, image fetching, and all real API/provider activity. Fixture actions must be local/no-op; never reuse production connections.

**Existing file:** `packages/desktop/Sources/AutopodDesktop/Views/DesktopDesignPreview.swift`.

Add a fixture-options toggle for this 1,000-pod fixture, with selection reset to a valid fixture pod when toggled. Existing design fixtures remain the default. Expose the same fixture inputs and cached loaders to the timing harness. This option exists only in the already explicit design-fixture screen.

#### 2. Mounted native interaction harness

**New files:**

- `packages/desktop/Tests/AutopodUITests/DesktopSelectionPerformanceTests.swift`
- `packages/desktop/Tests/AutopodUITests/DesktopSelectionPerformanceHost.swift`
- `scripts/measure-desktop-selection.sh`

Mount the production `MainView` with writable selection and private fixture `UserDefaults`. Use a real 1,800 × 1,050-point dark AppKit window. Adapt the existing host pattern; do not change its shared defaults or remove existing assertions. Serialize this suite and clean up windows, tasks, and defaults after failure as well as success.

Define the metric as **native accessibility-action dispatch through verified selected state and laid-out cached content**. Locate the action target before starting `ContinuousClock`; invoke the real title/tab action; yield to the main run loop; force layout and check both selected ID/tab and destination content. Finish only when content belonging to the target is laid out. A changed binding alone is not completion. Use a fixed five-second failure deadline, bounded yielding/polling, and report timeouts as failures rather than omitting samples. This is not compositor-presentation or physical mouse hardware latency.

Use animations disabled for the automated harness, as in the existing native host. The live Preview walkthrough retains normal animation. Keep setup, fixture creation, initial mounting, target lookup, warmup, and reset-to-start navigation outside the timed interval. Include action processing and destination layout inside it.

Measure these scopes separately: Active, All pods/Recent, and All pods/Recent with a repository selected (100 matching pods and a 50-pod recent cap). In each scope measure actual alternating pod selections and each enabled cached nonterminal top-level tab: Overview, Work, Validation, Readiness, Evidence, Diff, and Logs. Each target transition must start on a different pod/tab. Do not pool unlike cases to hide a slower one.

For each case, perform 20 warmups followed by 100 recorded transitions. Report every duration, p50, nearest-rank p95 (`sorted[94]` for 100 samples), maximum, timeouts, and counts exceeding 250 ms. Gate each case separately at p95 ≤ 250 ms in verify mode.

Bound a severely stalled baseline: after three five-second timeouts in a case, including warmup attempts, stop that case and record it as aborted with every attempted duration and the unsampled count. Continue to the other case entries. Do not calculate a passing percentile from a partial case or silently substitute five seconds for its true duration. A complete baseline case has the full distribution; an aborted baseline establishes timeout observations only. Verify mode fails an aborted or partial case and never claims the target passed without all 100 observations. Target lookup/reset also has a bounded deadline; failures are reported against that case rather than hanging the suite.

The script builds/runs the suite using `swift test --package-path packages/desktop -c release --no-parallel --filter DesktopSelectionPerformanceTests`. Supply record/verify mode and an absolute JSON report path through test-process environment variables owned by this script. Record the fixture hash, relevant source hashes, Git HEAD/dirty state, machine/OS, Swift/Xcode versions, build configuration, window/animation settings, case matrix, and requested/actual sampling parameters. Reject malformed/missing cases, unexplained missing metrics, and verification reports whose fixture or configuration differs from baseline. Explicitly aborted baseline cases are valid failure evidence, not complete numerical distributions; compare their timeout status with the completed after-case rather than inventing a speedup. Do not include credentials, real pod data, or raw remote URLs.

Default ordinary test runs execute a small functional pass of this fixture suite; full 100-sample qualification is opt-in through this script. The local Mac is the qualification host; no wall-clock SLA is imposed on shared CI machines. Verify mode requires the baseline report path as a third argument.

### Success Criteria

#### Automated Verification

- [x] `bash -n scripts/measure-desktop-selection.sh` passes.
- [x] `swift test --package-path packages/desktop --no-parallel --filter DesktopSelectionPerformanceTests` verifies real selection/content transitions and fixture isolation.
- [x] `./scripts/measure-desktop-selection.sh record /private/tmp/autopod-desktop-selection-before.json` produces all required baseline cases with truthful success/timeout observations.
- [x] Record the baseline summary and source/configuration identities in this plan's implementation progress section (sequencing adjustment: source editing began while the frozen original executable continued sampling; see execution notes). A baseline meeting the target is a valid observation, not an invented failing test; document any difference from the earlier installed-app symptom.

#### Manual Verification

No human judgment is required to establish the automated baseline. The visual/physical-input check is reserved for Phase 3. Once implementation is approved, proceed to Phase 2 after these automated checks; do not request an intermediate manual approval.

---

## Phase 2: Shared Derivation, Isolated Tabs, and One History Request

### Overview

Implement the approach above without changing archive/navigation semantics or history refresh policy.

### Changes Required

#### 1. Repository and fleet presentation

**New file:** `packages/desktop/Sources/AutopodUI/Models/DesktopFleetPresentation.swift`.

**Existing files:**

- `packages/desktop/Sources/AutopodUI/Models/DesktopPresentation.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`

Implement the index/cache and one-per-body fleet presentation. Pass the shared values through `podNavigation`, toolbar, content, grid/list, and footer builders. Preserve the existing static helper calling defaults. Use pure/internal injectable repository normalization in cache unit tests to count actual normalization calls; no production analytics or logging hook is required.

**New file:** `packages/desktop/Tests/AutopodUITests/DesktopFleetPresentationTests.swift`.

Test unchanged-input reuse; single-source change; add/remove/reinsert; transition to/from explicit empty/unavailable; mutable-profile edits affecting only legacy pods; captured repository precedence; duplicate identities; counts; credential-free display; and current Pod values in the displayed snapshot after activity/status updates. Assert normalization counts on the actual cache: no additional parsing for unchanged sources, no N-per-item footer derivation, and no reparsing of unchanged sources after one pod changes. Use 1,000-pod cases to cover the original scale.

#### 2. Navigation observation boundary

**New files:**

- `packages/desktop/Sources/AutopodUI/Models/DesktopDetailNavigation.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/DesktopDetailNavigationHost.swift`
- `packages/desktop/Tests/AutopodUITests/DesktopDetailNavigationTests.swift`

**Existing file:** `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`.

Wire the retained navigation object and host. Use mounted tests, not only direct property assertions: switch tabs, switch pods retaining Diff/Work, request a tab on the already selected pod, reveal an archived target from another workspace, fall back from unavailable Terminal, and exercise a same-pod repeated tab request after the prior request was consumed. Verify an available terminal subtree is retained across tab changes. Existing `DetailPanelView` binding-based fixtures must compile and pass unchanged.

#### 3. Selected-pod history lifecycle

**New files:**

- `packages/desktop/Sources/AutopodDesktop/Views/SelectedPodHistoryLoader.swift`
- `packages/desktop/Tests/AutopodClientTests/SelectedPodHistoryLoaderTests.swift`

**Existing file:** `packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift`.

Use the one history-owner modifier and remove the duplicate callback call. Mount the actual modifier with `PodStoreLifetimeFixture`/held `ConfirmedActionPeer` transport. Cover an initially selected pod; A → B → A; parent/event updates with unchanged selection; and a selection superseded while hydration is held. Assert one historical GET per selection activation, and zero new historical dispatch from a cancelled hydration continuation. Close pending requests and dispose tasks on every path.

Also exercise explicit reload and full-history calls, and retain existing resync/deduplication tests. No source change to `EventStream` is planned.

### Success Criteria

#### Automated Verification

- [x] `swift test --package-path packages/desktop --no-parallel --filter 'DesktopFleetPresentationTests|DesktopDetailNavigationTests|DesktopSelectionPerformanceTests'` passes.
- [x] `swift test --package-path packages/desktop --no-parallel --filter 'SelectedPodHistoryLoaderTests|EventStreamResyncTests|EventStreamDedupeTests|PodStoreLifetimeTests'` passes in the client test process.
- [x] Existing repository/navigation helpers remain covered by `swift test --package-path packages/desktop --no-parallel --filter 'repository|capturedRepository|modernCapturedIdentity|explicitFleetNavigation|detailTabSelection|seriesPodsDefault|artifactPodsDefault|browseRecent|browseArchive|analyticsSelectPod'`.
- [x] `./scripts/measure-desktop-selection.sh verify /private/tmp/autopod-desktop-selection-after-timestamps.json /private/tmp/autopod-desktop-selection-before.json` captures matching cases and meets p95 ≤ 250 ms for each case. Earlier failed reports remain preserved.
- [x] Compare cold index construction, cached normalization counts, and before/after timing distributions. A percentage speedup alone does not satisfy the absolute target.

#### Manual Verification

No intermediate manual check. Proceed to final qualification after the automated checks. If the target still fails, profile the same harness and continue investigating within the approved rendering/selection scope. If meeting it requires a broader architecture or semantic change, report Expected / Found / Why it matters / Proposed adjustment before departing from this plan.

---

## Phase 3: Desktop Qualification and Live Walkthrough

### Overview

Validate the completed implementation, build a separate Preview app, and check real mouse behavior. Automated native timing and human responsiveness judgment are distinct evidence.

### Changes Required

#### 1. Regression and build qualification

Run the canonical desktop suite once after focused checks pass. Build the separate Preview with the shared performance fixture. Inspect the final diff and record actual commands/results, report summaries, source identity, limitations, and any remaining manual item in this plan. Do not rerun completed broad checks without a code change or unresolved failure that warrants it.

#### 2. Native UI walkthrough

Use Computer Use against the separate Preview app. In design-fixture mode enable the 1,000-pod fixture, then exercise Active, All pods/Recent, repository filtering, search, archive, pod changes, and every enabled detail tab with mouse-coordinate clicks. Verify the selected highlight, header, and destination content agree. Keep normal animation enabled. Exercise rapid switches and confirm that slower loads do not show a previous pod's content as the new selection.

Where the Preview is already connected or the user completes its existing sign-in flow, repeat read-only navigation against the same real daemon/fleet as the original report. Preview has its own identity/credentials; do not copy production Keychain items or silently switch the installed app. If a connected walkthrough is unavailable, report that concrete limitation and leave its manual checkbox open. It does not block offline/native qualification, but the original live symptom is not marked fully verified without that check.

### Success Criteria

#### Automated Verification

- [x] `./scripts/test-desktop.sh` passes all discovered desktop test targets in their documented separate processes.
- [x] `./scripts/build-desktop-preview.sh --fixtures` builds and verifies the signed separate Preview app.
- [x] The native performance verify report contains all cases, 100 observations per case, no skipped failures, and a passing per-case p95 target.
- [x] `git diff --check` passes. Review confirms the diff is confined to the planned desktop, fixture, measurement-script, and RPI artifacts. The installed app has not been replaced.

#### Manual Verification

- [x] Agent's Computer Use walkthrough confirms the 1,000-pod Preview changes selections/tabs coherently with ordinary mouse input and animation; the user accepted the Preview result with “Seems fine.”
- [x] The user confirms the updated Preview feels responsive during repeated pod and tab switches (“Seems fine”).
- [ ] User confirms responsiveness on the original live fleet. The agent completed this check after the authorized production rebuild/install; independent human confirmation of that connected session is not claimed.
- [ ] Explicit archived-pod navigation, repository filter/footer totals, retained valid tabs, default/fallback tabs, and terminal retention behave as expected in the final UI.

**Implementation note:** Stop after final automated qualification and the agent's walkthrough to request the user's manual confirmation. Never mark the user acceptance checkbox complete from a tool observation or benchmark alone.

## Testing Strategy

### Unit Tests

Use behavioral repository/index tests to cover source precedence and invalidation, rather than checking private storage shape. Existing selection-helper tests continue to cover their public behavior. Cache-call counts test eliminated repeated parsing at realistic fleet size; the metric suite tests the mounted result.

### Integration Tests

Use the mounted production `MainView` and detail host for navigation and timing. Use the actual selected-history modifier with held REST requests for lifecycle/request count, independent of real daemon latency. Include a response-held case that confirms the UI selection can complete before history finishes. Keep existing event merge/resync and hydration-ownership coverage.

### Manual Testing Steps

1. Open the separate Preview build, enable its 1,000-pod fixture, and compare Active with All pods/Recent.
2. Alternate two pods, then switch Overview → Work → Validation → Readiness → Evidence → Diff → Logs. Observe the corresponding content and selected state, not only a button highlight.
3. Filter to one repository, verify the total is 100 and recent membership is capped as designed, then use Archive and a search matching an older pod.
4. Open an archived pod explicitly from another workspace, preserving its requested destination tab and visibility.
5. Exercise interactive/Terminal availability and tab persistence through the existing fixture/correctness cases; do not start real terminal work just for this timing check.
6. Repeat read-only navigation on the original fleet through the Preview's existing connection flow when available. The user confirms perceived responsiveness before manual acceptance is marked complete.

## Performance Considerations

The local Release metric is action-to-laid-out-cached-content, not physical input-to-displayed-frame or an API SLA. Automated animation is disabled and live animation is checked separately. Network response time, app startup, first fixture mount, and first cold index construction are excluded from the cached target and reported separately when observed. No claim is made that all time in the original 11-second computer-use outlier belongs to repository processing.

The index retains only current pod IDs and compact repository inputs/results; removal and connection-source replacement must evict obsolete entries. Current values are used for visible pods. There is no expiry-based staleness window. Filtering/search still scans the relevant loaded data, and changed source keys still require a cheap O(N) check; this plan does not promise constant-time updates for arbitrary archive sizes.

## Migration Notes

No persistence or API migration. `DetailPanelView`'s public binding initializer remains usable. Repository display and archive/navigation semantics are preserved. The cache/navigation objects are local to the view lifecycle; no new persisted preference is required for production. The new fixture toggle belongs only to the explicit Preview fixture screen.

Rollback consists of reverting the scoped source changes and rebuilding; no daemon/database action is needed. The separate Preview can be closed without altering the installed app. Installation, commits, pushes, and PR creation require separate user authorization.

## References

- Original task: this conversation, “when using the new desktop app ui, it takes several seconds to select a pod, or a tab in the pod detail pane.”
- Research: `thoughts/shared/research/2026-10-24-desktop-pod-selection-latency.md`.
- Existing native host: `packages/desktop/Tests/AutopodUITests/LaunchComposerTests.swift:359`.
- Existing held HTTP transport: `packages/desktop/Tests/AutopodClientTests/HeldRESTTransport.swift:23`.
- Existing hydration fixture: `packages/desktop/Tests/AutopodClientTests/PodStoreLifetimeFixture.swift:7`.
- Repository invariants: `packages/desktop/Tests/AutopodUITests/DesktopPresentationTests.swift`.
- Archived navigation: `packages/desktop/Tests/AutopodUITests/FleetPodNavigationTests.swift`.
- Desktop process isolation: `docs/desktop/test-isolation.md`; `scripts/test-desktop.sh`.
- Separate Preview build: `scripts/build-desktop-preview.sh`; `packages/desktop/Sources/AutopodClient/DesktopIdentity.swift`.

## Implementation Progress

The user explicitly approved this detailed plan on 2026-10-24. All approved implementation phases and automated checks have passed. The original baseline is captured, all rendering/history changes and regression checks passed, and the final full Release qualification passed after the user unlocked the desktop. The agent's unlocked physical-input walkthrough also passed; the user then accepted Preview responsiveness with “Seems fine.” Original-live-fleet verification and explicit human confirmation of the remaining navigation/Terminal checklist are not claimed. No unresolved design choices remain: measurement boundary/host/configuration, scope, caching semantics, navigation ownership, history ownership, verification, and rollout are specified above.

After approval, read `/Users/ewi/.codex/skills/rpi/references/implement.md` completely, reload this plan and its research artifact, verify the live source still matches, and start Phase 1. No explicit compaction capability is available in this session; continue from these artifacts without claiming a context reset. No configured Thoughts sync was established for this checkout, so no sync was attempted.

### Execution notes

- Xcode 27.1 / Swift 6.4 required the standard missing Metal Toolchain component; installed with `xcodebuild -downloadComponent MetalToolchain`.
- Release compilation exposed an existing implicit Task capture in `PodStoreFleetTests.FleetURLProtocol`. Capturing the immutable request and the existing Sendable protocol/handler explicitly, as newer fixtures already do, is the only supporting change outside the listed files.
- The Debug functional harness passed all 24 scope/action cases. Before the fix, repository-filtered transitions took approximately 3.2–3.7 seconds. These are single observations, not qualification percentiles. A short native stack sample placed the sampled work under `browseArchiveFooter` → `repositoriesByPod`.
- Minor sequencing adjustment: once the original Release binary was compiled and its hash-recorded baseline process was running, Phase 2 source edits began while that unchanged executable continued sampling. The measured fixture/harness remains unchanged. After the original process had run for over 19 minutes, a single-job compile (without test execution) was started in a separate temporary scratch directory to check the drafted changes; baseline timings may include that contention. The final after-change timing qualification will run without a competing build. Do not describe the baseline as an isolated-machine experiment or infer a precise causal speedup from it. Results are recorded before after-change validation; source edits cannot change the already loaded baseline binary.

- The drafted UI, desktop bridge, and every test module compiled successfully using `swift build --package-path packages/desktop --scratch-path /private/tmp/autopod-desktop-validation-build --build-tests -j 1` (222.08 s). Focused correctness runs use that separate scratch directory while the original baseline continues. Their timings are not the qualification metric. The baseline may include both compilation and focused-test contention; final Release timing verification remains isolated.

- The 14 focused history/event/store tests passed, including initial selection, A → B → A, unchanged parent updates, explicit reload/full history, and cancelled hydration. The first new navigation test incorrectly used the eager explicit-navigation helper to simulate an unavailable Terminal request; corrected it to write the request-only binding, matching the existing terminal-attachment path. The terminal subtree retention/fallback test passed.
- The first functional after-change run still observed 412–497 ms for Logs (one sample per scope, under concurrent baseline load). Investigation within the approved rendering scope found `LogStreamView` re-filtered all events for each row's final-divider check. It now derives visible events once per body and shares them with toolbar/content. This preserves filtering, ordering, scrolling and row actions. Qualification uses the unchanged 300-event fixture and unchanged timing harness.

- Focused UI checks passed (7 tests), including mounted History → archived pod navigation with repository/search clearing and retained Work. Existing helper/fleet regressions passed in separate UI/client processes (14 + 12 tests). These runs used `--scratch-path /private/tmp/autopod-desktop-validation-build`; no fixture/harness changes were made.
- `./scripts/build-desktop-preview.sh --fixtures` passed and `codesign --verify --deep --strict` verified bundle `com.autopod.desktop.preview`. Computer Use used ordinary mouse-coordinate clicks with normal animation for Active, All pods, all seven enabled detail tabs, repository filtering (50/100), archive (100), older-pod search, valid-tab retention and History → archived pod in another repository. Selected IDs, headers, summaries and destination content agreed. This records the agent walkthrough only; human acceptance boxes remain open.
- Connected Preview navigation remains unverified: its connection screen has no saved daemon connection and shows a new Local/localhost setup. Cancelled setup without saving a connection or copying credentials. Closed Preview before final timing qualification. The canonical suite is queued on SwiftPM’s lock until the original baseline ends.

- After more than 40 minutes of baseline execution, offered the user a choice to retain the full agreed baseline or stop it while keeping full after-change qualification. Until a response, the baseline continues unchanged. A brief LLDB attach/`fflush(0)`/detach succeeded but did not expose buffered Swift Testing output. This adds a debugger interruption to the baseline limitations; no debugger is used for final qualification. The original Debug functional log and native samples remain diagnostic evidence regardless of the full baseline outcome.

### Original Release baseline result

The original binary completed the full case matrix without cancellation. Report: `/private/tmp/autopod-desktop-selection-before.json` (raw observations alongside it). All four recorded original source hashes match `git show 4c98ab935cb5100968a62e6d431e95f890700a5f:<path>` exactly. Original UI test binary SHA-256: `d80f20b388dad91aac1bff1bcdcbb39b182d1134214ac239b9831ac4816f86d8` (manifest `/private/tmp/autopod-desktop-original-binary-identity.json`). Fixture, harness, Swift/Xcode, OS and Release configuration are recorded in the report and must match final verification.

22 cases completed with all 20 warmups and 100 observations. Active p95 values ranged 94.6–451.8 ms; Recent ranged 158.4–501.1 ms. Completed repository-filtered cases ranged 1,366.6–2,068.9 ms. Repository/Validation aborted after three failures (72 recorded successes); repository/Diff had two failures and incomplete sampling (99 observations, 19 warmups). Their p95 values are explicitly unavailable. Active and Recent already met the target for several tabs; Logs and all completed repository-filtered cases failed. The baseline includes earlier builds, focused tests, a brief debugger interruption, and the later contended Release diagnostic; it cannot establish a precise isolated causal speedup. Source editing began while the frozen original process ran, as documented above; this result closes the deferred Phase 1 evidence item.

- First canonical run: client target passed 359 tests; desktop target passed 7 XCTest checks but had one failure among 18 Swift Testing tests (`ProfileAuthenticatorTests.cancellationWaitsForTerminalBeforeDeletingIsolatedCredentials`, unchanged test/source). Its two-second synchronous wait did not observe the synthetic terminal status under the concurrent Release diagnostic. UI target was not reached because the runner correctly stopped. Investigating and rerunning without competing tests; no auth assertions or production behavior have been changed.

- The user chose “Keep the full approved baseline”; it had completed naturally before the reply. No baseline sampling was reduced or cancelled.

### Remaining Logs rendering refinement

The separate contended Release diagnostic completed 2,400 recorded observations but failed qualification: Recent/Logs p95 397.8 ms, repository/Logs 331.8 ms, and one repository/Diff warmup timeout. It is diagnostic evidence only (`/private/tmp/autopod-desktop-contention-diagnostic.raw.json`). The unchanged auth cancellation test then passed alone in 57 ms; the full suite must still be rerun without competing work.

Continuing within the approved rendering scope, replaced Logs’ first-appearance `ScrollViewReader.scrollTo` jump with SwiftUI’s native bottom anchor for the initial offset. This preserves starting at the newest event and keeps existing pinned auto-scroll on new events. Added a mounted Logs check for the newest row’s visible frame, expansion, search and type filters. The fixture and metric harness remain byte-for-byte unchanged. Results pending.

- Final focused UI group passed 9 tests in 4 suites (11.186 s), including Logs newest-row visibility, expansion, search and type filters. The single-observation Debug Logs transitions were 148.0 / 171.5 / 209.7 ms for Active / Recent / repository; these are functional observations, not p95 qualification. The actual cache test measured cold 1,000-pod index construction at 5.73 ms and unchanged-source refresh at 2.95 ms with zero extra normalizations (one Debug observation each, no SLA assertion).

- Final Preview rebuild and strict signature verification passed. Computer Use confirmed the final native initial bottom offset (scroll bar value 1, event 299 visibly at bottom) and mouse-entered Logs search narrowed 300 events to one. Closed Preview before the uncontended canonical-suite rerun and final qualification.

- Uncontended canonical rerun passed all discovered targets: 359 client + 18 desktop + 221 UI Swift Testing tests (598 total), plus 7 desktop + 6 UI XCTest checks (13 total). This includes the unchanged authentication cancellation test; no auth test or source was edited. Log: `/private/tmp/autopod-desktop-full-suite-final.log`. No other Swift test/build or Preview process remained when final Release qualification was launched.

### First isolated qualification: target not yet met

`/private/tmp/autopod-desktop-selection-after.json` preserves the first isolated result (537.883 s of sampling). Active and Recent passed every p95 gate; repository/Logs remained 353.3 ms and repository/Diff repeated a first-warmup timeout, also observed in the original baseline and contended diagnostic. This report is explicitly failed; qualification boxes remain open.

Further Logs rendering investigation found a fresh `DateFormatter` constructed by every row’s `AgentEvent.timeString`. Logs now creates one formatter per content render and supplies formatted timestamp strings to its rows, preserving the exact `HH:mm:ss` format and current locale/timezone behavior without a persistent formatter cache or model/API change. The mounted test now checks equivalence with the existing timestamp format. All nine focused UI tests passed (9.187 s), with a single Debug repository/Logs observation of 142.9 ms; full qualification still required. Added a focused repeated Evidence → Diff regression to isolate the first-entry timeout rather than discard it.

- A separate traced Release stress test passed 360 Diff entries across three windows after repeated Evidence navigation (107.207 s); first repository entry also passed. A targeted native sample is saved at `/private/tmp/autopod-desktop-diff-first-entry-sample.txt`. This does not establish the cause of the benchmark’s first-entry timeout. Removed the temporary trace mode; retained a smaller mounted 120-cycle Evidence → Diff regression. No Diff production source, parser, refresh policy, deadline or warmup requirement was changed. Next: rebuild Preview, rerun the canonical suite, then rerun the unchanged full benchmark with the timestamp refinement.

- Latest Preview rebuild and strict signature verification passed. Computer Use then returned `cgWindowNotFound`, followed by “The Mac is locked and automatic unlock could not unlock it.” Asked the user to unlock while automated checks continue. Latest timestamp-rendering mouse verification and final timing in the original unlocked desktop conditions remain pending; no manual result is claimed from the locked session.

- Latest canonical suite passed under the locked desktop: 359 client + 18 desktop + 222 UI Swift Testing tests (599 total), plus 13 XCTest checks (612 checks). This includes the retained repeat-navigation Diff regression and timestamp-format equivalence assertion. Log: `/private/tmp/autopod-desktop-full-suite-timestamps.log`.
- Since the actual mounted AppKit/AX correctness suite works while locked, continuing the unchanged native action-to-laid-out-content benchmark without waiting for physical access. The metric explicitly excludes compositor presentation and physical mouse latency. Record the locked-desktop condition as a limitation; no claim of identical before/after desktop conditions or a precise causal speedup. The real mouse walkthrough remains blocked on unlock. Fresh report: `/private/tmp/autopod-desktop-selection-after-timestamps.json`; preserve the failed earlier reports. No competing build/test/debugger is running.

### Final automated result — manual verification pending

Recorded 2026-10-25T00:22:06.083256+02:00. The unchanged native benchmark passed all 24 cases, 20 warmups and 100 recorded transitions per case: 2,400 observations, zero failures/timeouts, and zero recorded durations over 250 ms. Worst per-case p95: 152.89 ms (repository/Logs); maximum observed duration across all cases: 173.70 ms. The first repository/Diff warmup succeeded. No Diff source or polling behavior was changed; this clean result does not by itself identify the earlier warmup timeout's cause.

The exact fixture/harness/configuration hashes match the original baseline. The original baseline was contended and had a brief debugger interruption; the latest passing qualification ran while the desktop was locked. Treat these as absolute native state/layout measurements, not a precise isolated speedup or a physical-input/compositor claim. Unlocked Preview and original-fleet acceptance remain required.

| Action | Active p95 (ms) | Recent p95 (ms) | Repository p95 (ms) |
| --- | ---: | ---: | ---: |
| pod | 86.25 | 137.24 | 140.55 |
| overview | 38.62 | 52.96 | 57.41 |
| work | 35.73 | 51.75 | 54.77 |
| validation | 39.73 | 55.06 | 55.99 |
| readiness | 27.35 | 43.30 | 42.72 |
| evidence | 28.31 | 43.56 | 45.54 |
| diff | 67.98 | 112.24 | 104.16 |
| logs | 124.61 | 143.66 | 152.89 |

Evidence:
- Passing report: `/private/tmp/autopod-desktop-selection-after-timestamps.json` (raw 2,400 observations alongside it).
- Latest canonical suite: `/private/tmp/autopod-desktop-full-suite-timestamps.log` — 599 Swift Testing + 13 XCTest checks, all passed.
- Latest signed Preview: `packages/desktop/build-preview/Build/Products/Debug/Autopod Preview.app`; strict signature verification passed.
- Source and binary identity manifest: `/private/tmp/autopod-desktop-final-source-identity.json`.
- Final source-set SHA-256: `5303f1ca2e67464e1eb92b27aafbd18268944f9aba37d73c9d71e15961d8dd6d`.
- `git diff --check` passed. Final review includes the scoped shared-index/navigation/history changes, Logs filtering/initial-offset/timestamp rendering, fixtures/tests/scripts, and RPI artifacts. The only supporting existing-test edit is the Swift 6.4 explicit capture in PodStoreFleetTests. No installed app replacement, commit, push, PR, daemon change, or credential migration.

Next incomplete work: inspect the latest Preview with ordinary mouse input after unlock, and repeat pod/tab selection against the original live fleet through Preview’s existing connection flow. Ask the user to confirm perceived responsiveness and the manual navigation/terminal checks before marking any manual item complete. No further implementation phase is pending unless that verification exposes a problem.

### Unlocked desktop verification

After the user said “Unlocked now,” Computer Use successfully accessed the latest signed Preview. With ordinary mouse-coordinate clicks and normal animation, enabled the shared 1,000-pod fixture, selected different Active pods while retaining Work, and opened Overview, Work, Validation, Readiness, Evidence, Diff and Logs. Selected IDs, headers and destination content agreed. Repository-5 showed 50/100 recent pods; selecting an older search result retained it as the 51st visible pod after clearing search. Archive then showed all 100 repository pods. History search/open for perf-0999 cleared the prior repository restriction, revealed 1,000 archive pods, retained Work, and showed perf-0999’s summary. Logs initially showed event 299 at the bottom of 300 events; mouse-entered search narrowed it to one event. These are agent observations; all human manual-verification checkboxes remain open.

Closed Preview before repeating the unchanged full Release timing command with fresh output `/private/tmp/autopod-desktop-selection-after-unlocked.json` and log `/private/tmp/autopod-desktop-unlocked-qualification.log`. No competing build, test or debugger was started. The Swift incremental build completed in 0.42 seconds; sampling is running. Original-live-fleet navigation still needs a connection through Preview’s existing setup flow; no credentials were copied or connection saved.

### Final unlocked qualification — passed

The full run completed in 426.622 seconds with all 24 cases complete: 20 warmups and 100 recorded transitions per case, 2,400 recorded observations, zero failures/timeouts. Every case met p95 ≤ 250 ms. Worst p95 was 165.89 ms (Recent/Logs). One recorded Recent/Logs transition took 416.01 ms; all other recorded transitions were ≤ 250 ms. The outlier is retained, not discarded. The first repository/Diff warmup also passed. The earlier timeout's precise cause remains unproven; no Diff production code or sampling rules were changed.

| Action | Active p95 (ms) | Recent p95 (ms) | Repository p95 (ms) |
| --- | ---: | ---: | ---: |
| pod | 94.13 | 147.83 | 138.52 |
| overview | 41.40 | 59.15 | 57.34 |
| work | 40.17 | 53.78 | 58.17 |
| validation | 40.43 | 58.64 | 59.72 |
| readiness | 27.07 | 46.98 | 45.60 |
| evidence | 28.78 | 61.80 | 46.19 |
| diff | 73.99 | 135.21 | 114.31 |
| logs | 134.25 | 165.89 | 154.19 |

Fixture, harness and configuration match the original baseline exactly. All 18 final source hashes still match the tested source manifest. Computer Use succeeded immediately before the run and again when reopening Preview after it ended; the desktop was accessible at both observations. This remains a native action-to-state/layout metric, not compositor or physical hardware latency. The original baseline's contention/debugger caveats still prevent a precise causal percentage-speedup claim.

Final evidence:
- Passing unlocked report: `/private/tmp/autopod-desktop-selection-after-unlocked.json`; all raw observations in `/private/tmp/autopod-desktop-selection-after-unlocked.raw.json`.
- Qualification log: `/private/tmp/autopod-desktop-unlocked-qualification.log`.
- Final source/binary manifest: `/private/tmp/autopod-desktop-unlocked-source-identity.json`; unchanged source-set SHA-256 `5303f1ca2e67464e1eb92b27aafbd18268944f9aba37d73c9d71e15961d8dd6d`.
- Latest canonical suite remains 599 Swift Testing + 13 XCTest checks, all passed; no source changes since that run.
- Final `git diff --check` passed.

Reopened the signed separate Preview and enabled the 1,000-pod fixture for the user's review. The installed app remains untouched. Next action is the RPI human verification gate: user confirms responsiveness and the listed navigation/Terminal checks; original-live-fleet navigation still needs Preview's existing connection flow. All manual boxes remain open pending user confirmation. No further implementation phase is pending unless manual verification finds a defect.

### User acceptance

The user responded “Seems fine” after the final results and request to try repeated pod/tab switches. Recorded acceptance of Preview responsiveness and the completed agent walkthrough. This does not establish that Preview was connected to the original daemon fleet or that the user independently exercised every navigation/Terminal case; those narrower unchecked items remain explicit limitations. A subsequent delayed reply to the earlier unlock prompt said “The Mac is unlocked”; the unlocked walkthrough and final qualification had already completed, so no redundant rerun is needed. Implementation is ready locally, with no commit, push, PR, installation or deployment authorized by this acceptance.

### Release authorization

The user subsequently instructed: “Okey get it all to main. Deploy. And rebuild desktop app.” This separately authorizes committing/publishing these changes, integration into main, ordinary hosted-daemon deployment, and rebuilding/installing the desktop app. It supersedes the earlier rollout non-goal for these actions. It does not authorize forcing a daemon restart over active pods. Fetched main at `42c1c01e832d9d3d5b4241bd649cb2b587d4521d`; its two intervening commits do not touch desktop sources. Existing manual-verification limitations remain documented rather than being marked passed by release authorization.

### Release execution

- Published PR https://github.com/esbenwiberg/autopod/pull/451 after a clean rebase onto current main. Required local lint, typecheck and secret scan passed; lint reported preexisting warnings. All 18 qualified desktop source/harness/script hashes were unchanged by the rebase.
- Built and signed the production Release app, then ran `./scripts/install-desktop.sh`. Strict signature verification passed for both build and `/Applications/Autopod.app`; installed executable SHA-256 matches the build: `ba971687bf73029e7b1a17642ce1fe6b48ae4f072f31f7b91f893024bdbc49ab`. Previous app backed up at `/private/tmp/Autopod-before-selection-fix-20261025.app`. Logs: `/private/tmp/autopod-desktop-release-build.log`, `/private/tmp/autopod-desktop-release-install-app.log`.
- Reopened the installed app using its saved daemon connection, without credential copying. Computer Use on the original 957-pod fleet verified selecting select-pinniped, Work → sunny-whitefish with Work retained, all seven enabled detail tabs and their corresponding destination content, All pods recent membership (50/957), and the captured PowerGantt repository filter (5 matching pods). These are agent observations, not a new physical-input latency percentile or user confirmation of every navigation/Terminal case.
- Initial PR CI passed the JavaScript build/tests and secret scan, but macOS CI timed out in the new `historyOpensArchivedPodAndClearsFleetFiltersWithTabRetained` test; all other 611 checks passed. Failure log: `/private/tmp/autopod-desktop-release-ci-failed.log`. The test used full-tree AX scans to locate individual History controls in the 1,000-row view. Replaced those test-local lookups with early-exit traversal, waited for the first matching History row before checking its count, and added named timeout checkpoints. All original navigation/content/count assertions, the five-second wait deadline, product code, fixture and performance harness remain unchanged. The refined test passed locally in 3.064 seconds (`/private/tmp/autopod-desktop-history-ci-fix.log`); rerun CI before merge.
- Hosted daemon is healthy at clean release `42c1c01e832d9d3d5b4241bd649cb2b587d4521d`. Read-only preflight found restart blockers select-pinniped (validated), sunny-whitefish (validated), and partial-penguin (awaiting_input). No forced restart or daemon deployment has been performed; the deployment skill requires explicit interruption approval for these exact pods.
- The first correction passed locally but CI again timed out specifically at `History search control` (`/private/tmp/autopod-desktop-release-ci-retry-failed.log`), before the search/open assertions. Changed this unmeasured workspace-setup check to locate the native NSTextField by the same placeholder used by the actual edit helper, avoiding reliance on SwiftUI forwarding its AX identifier on older macOS. Setup has its own bounded 20-second wait and reports actual mount time; the immutable benchmark host still enforces its original five-second deadline. The native setup mounted in 1.201 seconds locally and the full History test passed in 3.079 seconds (`/private/tmp/autopod-desktop-history-native-readiness.log`). No product, fixture, timing-harness or assertion changes.
- An additional full local UI process passed the revised History test and all other affected checks but hit the unchanged Village WebKit readiness failures documented in `docs/desktop/test-isolation.md` (five assertions in two tests). Both WebKit tests then passed in a fresh process in 0.835 seconds, without renderer/test changes. Logs: `/private/tmp/autopod-desktop-ui-ci-correction.log`, `/private/tmp/autopod-desktop-village-isolated-release.log`. Preserve the failed run; do not call it a passing full-suite run. CI's first two runs passed those unchanged WebKit checks.

### Main integration and hosted rollout

- Final PR CI passed all 599 Swift Testing tests and 13 XCTest checks, Village renderer contracts, the macOS app build, JavaScript build/tests and secret scan. Desktop CI: https://github.com/esbenwiberg/autopod/actions/runs/40143384053; success log `/private/tmp/autopod-desktop-release-ci-success.log`. The native History field mounted in 8.835 seconds on macOS CI, within its separate 20-second unmeasured setup bound. The selection benchmark's immutable five-second deadline is unchanged.
- PR #451 merged as `d33c13fa0dc1187827d4b302b81daf746fd2914e`. Both this checkout and the primary main checkout were updated. The primary checkout's unrelated untracked drawing backup was preserved. Production desktop Release remains installed and verified; no desktop product source changed during the test corrections.
- The ordinary hosted deploy stopped at its three-pod restart guard. The user explicitly approved interruption of select-pinniped (validated), sunny-whitefish (validated), and partial-penguin (awaiting_input). A fresh check under the deployment drain found only those pods and zero queued pods.
- The first authorized staging attempt stopped at browser prewarm before activation; the old service remained healthy and the drain was released. The exact prewarm block passed independently. The full retry, with separate Azure response logging, passed build, reviewer CLI prewarm, Chromium launch, local health, external HTTPS 200 and exact clean build identity; it activated d33c13fa. Logs: `/private/tmp/autopod-desktop-approved-daemon-deploy.log`, `/private/tmp/autopod-desktop-prewarm-exact.log`, `/private/tmp/autopod-desktop-approved-daemon-retry.log`.
- Startup journal inspection found `Sandbox worker quiesce failed ... rm: cannot remove '/run/autopod/agent.pid': Permission denied` while preserving partial-penguin. Followed the deployment skill's rollback rule and restored clean healthy release `42c1c01e832d9d3d5b4241bd649cb2b587d4521d`. Rollback log: `/private/tmp/autopod-desktop-daemon-rollback.log`. Released the maintenance drain after diagnosis. Partial-penguin remains awaiting_input, with its original container reference and pending escalation retained. No task was resumed, killed through the pod lifecycle, or answered by the operator.
- `git diff 42c1c01e d33c13fa -- packages/daemon packages/shared packages/cli` is empty: the recovery defect is pre-existing and not introduced by the desktop change. Provisioning deliberately creates `/run/autopod` as root:root 0755 and `agent.pid` as autopod:autopod 0600 (`provisioning-agent-materials.ts`). `quiesceSandboxAgent` executes as the unprivileged agent and unlinks that file in both cleanup branches (`workspace-recovery-commands.ts`); owning the file does not grant write permission on its parent directory.
- A non-root local permission reproduction confirmed unlink exits 1 while in-place clearing succeeds, retaining the empty file and its 0600 mode without granting directory write access. Proof: `/private/tmp/autopod-sandbox-pid-permission-repro.json`. Complete rollout evidence: `/private/tmp/autopod-desktop-release-evidence.json`.

### Approved scope extension — sandbox PID cleanup

**Expected:** the approved restart preserves interrupted sandbox work and the hosted release passes post-startup journal checks.

**Found:** the existing recovery command cannot unlink an agent-owned PID file from the deliberately root-owned directory. Deployment was rolled back; the desktop fix is on main and installed, while the daemon remains on its healthy prior release.

**Why it matters:** ignoring this error would claim preservation succeeded when it did not. Weakening `/run/autopod` permissions would undermine the existing secret-file boundary. The approved UI plan explicitly excludes daemon changes, so this backend repair needs separate scope approval.

**Proposed adjustment:** change only the two PID cleanup strings in `packages/daemon/src/pods/workspace-recovery-commands.ts` from `rm -f "$pid_file"` to `: > "$pid_file"`. Keep the process termination sequence, file ownership/mode, directory permissions, API, lifecycle and pending-decision behavior unchanged. Add a non-root permission regression in the existing co-located test module, covering a terminated worker PID and the already-empty/invalid PID path. The test must fail against the current unlink behavior and pass against in-place clearing.

```diff
- 'case "$pid" in ""|*[!0-9]*) rm -f "$pid_file"; exit 0;; esac',
+ 'case "$pid" in ""|*[!0-9]*) : > "$pid_file"; exit 0;; esac',
  ...
- 'rm -f "$pid_file"',
+ ': > "$pid_file"',
```

If approved: implement this narrow repair, run the targeted workspace-recovery/reconciler tests and required repository checks, merge it to main, then retry the normal verified hosted rollout with the existing explicit interruption authority limited to the same three pods. Recheck the fleet before any restart; additional blocking pods require their own authority. The desktop rebuild is already complete and needs no product change for this backend-only repair.

- [x] User approves this daemon-only scope extension. User replied “Approve PID cleanup fix and redeploy.”
- [x] Regression reproduces the unlink permission error and passes with in-place clearing.
- [ ] Targeted backend checks and required repository validation pass.
- [ ] Repair is merged, deployed and verified with clean release identity, health, browser readiness and no recurrence of this preservation error.

Next action: implement and verify the approved repair, merge it, and redeploy. Existing interruption authority remains limited to the same three pods. Do not report the hosted rollout complete while the service remains rolled back.

### Approved PID cleanup implementation

Applied the two approved shell-string replacements. The non-root test executes the production command through the container seam against a 0600 PID file in a 0555 directory (the same effective directory access as the agent in root-owned 0755 `/run/autopod`). It covers a real spawned worker, empty and invalid contents, unchanged inode/ownership/mode, and repeated cleanup. Root/Windows runs skip this POSIX permission reproduction. Against old code, the worker case failed with permission denied and invalid contents remained uncleared; with the fix all 23 workspace-recovery/reconciler tests passed. Logs: `/private/tmp/autopod-pid-cleanup-red.log`, `/private/tmp/autopod-pid-cleanup-green.log`.

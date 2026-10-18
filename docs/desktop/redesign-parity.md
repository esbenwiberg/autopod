# Desktop redesign source parity

Reviewed 2026-10-18 against freshly fetched `origin/main`
`6e51d1ce9495235e6aac2e498393cd2dd9a0e66b`. Redesign baseline:
`7151cc6654939c5195e55c33c87d68de94fb96b9`, branch `codex/desktop-redesign`.

This is a source review plus the named automated checks. It does not substitute
for operating the connected Preview app. That walkthrough is deferred because
the user's Mac is locked. Keep PR #439 draft until live acceptance is completed.

## Reviewed routes and controls

| Surface | Source parity finding | Relevant automated checks |
| --- | --- | --- |
| Fleet | Search, repository filter, selection, refresh and creation remain reachable. Lifecycle rail and reported milestone token are separate. Repository identity comes from the pod snapshot/configuration lookup. | DesktopPresentationTests, FleetPodNavigationTests |
| Explicit pod navigation | History, Schedules, Analytics, palette and Series share a destination that clears stale search/repository filters. A selected archived pod survives the recent-results limit. Ordinary card and Village selections retain context. | FleetPodNavigationTests, AnalyticsWiringTests |
| Pod details | Overview, Work, Validation, Readiness, Evidence, Diff and Logs retained; Terminal remains conditional on interactive mode. Invalid old tab selection falls back. | DetailPanelTabSelectionTests |
| Pod actions | Redesigned header menu reuses `headerActions`; fleet context menu reuses `cardMenuActions`. Compared action references against main, then inspected the composition. Status-specific pause/resume/kill/retry/rework/approve/merge/manual repair/fork/delete/PR feedback paths remain wired. | ConfirmedActionRenderingTests, InlineControlRenderingTests, ConnectionOwnershipRenderingTests |
| Validation | One redesigned phase navigator; phase details use the existing data and current/history selection. Legacy phase chips are in the legacy branch. Review infrastructure unavailability remains distinct from a failed verdict. | ValidationHistoryIdentityTests, ValidationHistoryRefreshTests, ValidationProgressTests |
| Readiness | Existing findings, source references and waiver actions remain in shared sections. | FactWaiverRefreshTests (client); source review |
| Evidence | Screenshots, files, artifacts, markdown and lightbox reuse existing content/loaders; only section navigation and chrome change. | ValidationPageScreenshotTests; shared evidence content source review |
| Diff | Unified/split/file modes, refresh, file expansion, notes and parsing remain shared. | DiffTabExpansionTests; shared parser source review |
| Logs | Existing filtering/search, loading, copy and auto-scroll behavior retained in new chrome. | EventStream tests; connected scrolling remains a live check |
| Terminal | Existing SwiftTerm/data pipe and session controls retained; only toolbar label added. | Source review; connected terminal input remains a live check |
| Series | Standalone Series list and pipeline retained, including purpose/design, summary, member quality/activity, PR links and delete confirmation. Drill-through opens full pod details or Validation. | DesktopSeriesTests, PipelineDAGLayout tests |
| Profiles | Profile library, building blocks, repositories, watchers and deployments retained. Shared editor covers every configuration kind, full JSON, reference navigation, stale revisions, save/discard and provider-account routing. | ConfigurationEditorLayoutTests, LaunchConfigurationTests |
| Settings | Appearance, Connections, Provider Accounts, Podsitter, Notifications, Logs and About remain reachable. Embedded settings use real AppRootView callbacks. Profiles has its own workspace and deep links. | DesktopSettingsLayoutTests, provider catalog and connection tests |
| Schedules | Create/edit/enable/disable/run/delete, templates, launch settings, last-pod navigation and scan policy/report routes remain wired. | ScheduledJobDraftTests, DesktopSchedulesLayoutTests, ScheduledScanTests |
| History / Analytics | Existing drill loaders, date-window propagation, charts and pod links remain wired. | DesktopInsightsLayoutTests, AnalyticsWiringTests |
| Memory | Review/library/extraction, candidate approve/reject/edit, active-memory create/edit/delete, evidence and usage remain reachable. Draft/busy/discard state reaches the shell. | MemoryWorkbenchTests, DesktopMemoryDraftTests, MemoryDraftSaveTests, DesktopKnowledgeLayoutTests |
| Managed pods | Original read-only inventory/detail and artifact viewer are reused; profile/account/search filters added. No repository identity is fabricated. | ManagedPodsViewTests, ManagedPodClientTests |
| Village | House entrance retained in redesigned sidebar. Native/managed namespaced selection, filtered pod list and detail navigation retained. | VillageSceneTests, VillageWebViewTests, Node renderer tests |
| Appearance / app identity | System/light/dark preference reaches the app root. Preview retains its separate bundle, defaults/keychain identity and build location. | Source review; signed Preview build |
| Launch / follow-up / repair | Explicit review and source context retained. Uncertain launch retries its exact request; only confirmed launch invokes navigation. Configuration/fleet ownership is checked through asynchronous refresh. Repairs retain feedback on uncertain responses. | LaunchComposerTests, FollowUpTests, FollowUpTransportTests, LaunchSelectionOwnershipTests |

## Intentional changes

- Remove Series from pod-detail tabs; keep the standalone Series workspace.
- Move secondary pod actions into the header menu to avoid a dedicated button row.
- Replace one-segment-per-milestone displays with reported progress and compact
  `M3/9`-style tokens. Lifecycle phases remain separate from task milestones.
- Use one validation phase navigator instead of duplicate phase boxes.
- Give Profiles its own workspace while keeping Settings and profile deep links.

## Automated evidence and limits

At the baseline above, Desktop CI on Xcode 16.4 / Swift 6.1.2 passed 552 Swift
Testing tests, 13 XCTest tests, 15 Node contract tests, `village:check` and the app
build. Repository CI and secret scanning passed. Signed separate Preview built.
The local full suite reproduced five assertions in two Village startup tests;
that investigation and the target-isolated runner are recorded in
[test isolation](test-isolation.md). No test assertions are skipped or
weakened to establish parity.

## Deferred connected Preview walkthrough

- Operate the sidebar, Settings/Profile deep links and repository filters.
- Open pods from History/Schedules/Analytics/Series with existing filters active.
- Exercise detail tabs across running, waiting, failed, completed and interactive
  pods; check menus and disabled/pending states without launching paid work.
- Inspect live terminal/log streams and real evidence/diff loading.
- Verify theme changes, window resizing and Village list/map/detail navigation.
- Confirm current-app and Preview isolation before deciding whether to merge.

Source review found no additional missing controls in the reviewed surfaces.
This is not an exhaustive assertion that every connected interaction works.

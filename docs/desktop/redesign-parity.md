# Desktop redesign source parity

Updated 2026-10-19 against freshly fetched `origin/main`
`6e51d1ce9495235e6aac2e498393cd2dd9a0e66b`. Redesign baseline:
`7151cc6654939c5195e55c33c87d68de94fb96b9`, branch `codex/desktop-redesign`.

This is a source review plus the named automated checks. It does not substitute
for operating the connected Preview app. Native access resumed on 2026-10-18,
but profile configuration gaps were then identified. The Profile, Workflow and
Repository/value-map repairs are now implemented and covered by native interaction
checks; see the [profile configuration audit](profile-configuration-audit.md).
Full Preview sample saves/reopens were operated through computer use. Keep PR #439
draft: [connected acceptance](connected-acceptance.md) now proves real configuration
persistence and isolation, but FAILED repository identity/filtering and initial
fleet milestone display. Both are now repaired and proven against local repaired HTTP routes in the
actual Preview; [hosted rollout/recheck remains pending](fleet-display-repair.md).

## Reviewed routes and controls

| Surface | Source parity finding | Relevant automated checks |
| --- | --- | --- |
| Fleet | Search, repository filter, selection, refresh and creation remain reachable. Lifecycle rail and reported milestone token are separate. Repository identity comes from the pod snapshot/configuration lookup. | DesktopPresentationTests, FleetPodNavigationTests |
| Explicit pod navigation | History, Schedules, Analytics, palette and Series share a destination that clears stale search/repository filters. A selected archived pod survives the recent-results limit. Ordinary card and Village selections retain context. | FleetPodNavigationTests, AnalyticsWiringTests |
| Pod details | Overview, Work, Validation, Readiness, Evidence, Diff and Logs retained; Terminal remains conditional on interactive mode. Invalid old tab selection falls back. | DetailPanelTabSelectionTests |
| Pod actions | Redesigned header menu reuses `headerActions`; fleet context menu reuses `cardMenuActions`. Compared action references against main, then inspected the composition. Status-specific pause/resume/kill/retry/rework/approve/merge/manual repair/fork/delete/PR feedback paths remain wired. | ConfirmedActionRenderingTests, InlineControlRenderingTests, ConnectionOwnershipRenderingTests |
| Validation | One horizontal icon/status card strip; phase details retain current/history selection. Legacy phase chips remain in the legacy branch. Review infrastructure unavailability remains distinct from a failed verdict. | DetailSectionNavigationTests, ValidationHistoryIdentityTests, ValidationHistoryRefreshTests, ValidationProgressTests |
| Readiness | Existing findings, source references and waiver actions remain in shared sections. | FactWaiverRefreshTests (client); source review |
| Evidence | Screenshots, files, artifacts, markdown and lightbox reuse existing content/loaders; only section navigation and chrome change. | ValidationPageScreenshotTests; shared evidence content source review |
| Diff | Unified/split/file modes, refresh, file expansion, notes and parsing remain shared. | DiffTabExpansionTests; shared parser source review |
| Logs | Existing filtering/search, loading, copy and auto-scroll behavior retained in new chrome. | EventStream tests; connected scrolling remains a live check |
| Terminal | Existing SwiftTerm/data pipe and session controls retained; only toolbar label added. | Source review; connected terminal input remains a live check |
| Series | Standalone Series list and pipeline retained, including purpose/design, summary, member quality/activity, PR links and delete confirmation. Drill-through opens full pod details or Validation. | DesktopSeriesTests, PipelineDAGLayout tests |
| Profiles | Library routes, configuration kinds, full JSON and revision/draft controls exist, but form completeness FAILED the follow-up audit. Network and sidecar defaults now have explicit controls; Workflow and repository/setup forms, reusable value/reference maps and skill description are repaired. Connected daemon acceptance remains pending. See [confirmed gaps](profile-configuration-audit.md). | ConfigurationExecutionInteractionTests, ConfigurationWorkflowInteractionTests, ConfigurationRepositoryInteractionTests and ConfigurationValueMapInteractionTests check the repaired fields; older layout tests establish fit only. |
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

## Connected Preview walkthrough and remaining checks

- Operate the sidebar, Settings/Profile deep links and repository filters.
- Open pods from History/Schedules/Analytics/Series with existing filters active.
- Exercise detail tabs across running, waiting, failed, completed and interactive
  pods; check menus and disabled/pending states without launching paid work.
- Inspect live terminal/log streams and real evidence/diff loading.
- Verify theme changes, window resizing and Village list/map/detail navigation.
- Confirm current-app and Preview isolation before deciding whether to merge.

The connected walkthrough is recorded in [connected acceptance](connected-acceptance.md).
Its findings supersede source-only claims about repository identity and initial
fleet milestone display. The unexercised states below remain separate from the
passing configuration checks.

The earlier review missed configuration fields and controls for absent/empty
values. That conclusion is superseded by the
[profile configuration audit](profile-configuration-audit.md). Connected proof is bounded by the acceptance report; passing layout tests alone
do not establish field completeness.

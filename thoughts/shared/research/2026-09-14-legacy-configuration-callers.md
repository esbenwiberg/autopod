# Legacy configuration caller review

Inspected the local candidate on 2026-09-14. This is a source review, not live cutover acceptance. The new admission gate remains closed.

The review covered direct `profileStore` readers, credential owner resolution, application route registration, and native account settings. It found a runtime credential readback path that still resolved an account through the old profile. That path now uses the pod's verified provider binding, including its selected fallback account. A regression removes the old profile account lookup after admission and verifies that rotated Codex authentication is persisted to the admitted account.

| Consumer | Candidate behavior |
| --- | --- |
| API registration and CLI entry point | Configuration routes and commands replace editable legacy profiles. The server retains old routes only in the explicitly uncomposed test/legacy construction path. |
| Provider account API | Legacy profile link, unlink and credential import operations return `CONFIG_API_VERSION_UNSUPPORTED` after cutover. Account authentication remains available. |
| Native provider accounts | Composed settings hide profile link/import and account-default fallback controls. “Open AI setups” opens the AI category in the configuration library. Authentication remains on the account screen; route selection and fallback belong to the AI editor. |
| Pod execution settings | `executionForPod` reads the immutable launch snapshot. A composed pod whose snapshot is missing fails; it cannot fall back to the old profile. The temporary Profile projection is removed. |
| Runtime credential readback | Uses `resolveEffectiveBoundProfile` and passes the explicit account owner to persistence. Historical inline-credential profiles retain their legacy path. A missing or mismatched current binding is caught and reported without writing another owner's credentials. |
| Diff and Podsitter evidence | Both use `podSourceContext`, which takes repository identity from the stored launch. Legacy profile lookup is confined to uncomposed history. |
| Memory candidates and pod bridge | Composed pods require their repository launch context. The bridge's legacy helper explicitly rejects composed pods. |
| Series | The configuration branch resolves an enrolled repository. An old profile-only request receives an upgrade error rather than being guessed into a repository. |
| Watchers | Production wiring supplies `configuration.watcherLaunches`; list and tracked-run lookup select that branch. The old profile reader remains for legacy fixtures. |
| Reference repositories | Composed launches use admitted revision archives. The old helper loop is empty for composed launches. Docker archive ownership was separately verified. |
| Workspace worker handoff | The composed branch uses the pinned worker configuration and returns before the legacy worker-profile fallback. |
| Warm image maintenance | The old maintenance class remains for historical tests, but startup no longer schedules it. Shared software image identity is handled by configuration. |
| Deployment | Composed requests resolve a deployment definition and run the exact published default-branch commit in an isolated Docker runner with deployment-specific credentials. Legacy host deployment remains rejected on the composed path. |
| Test pipelines | Retired by product decision on 2026-09-14. They are absent from composable schemas; conversion records enabled legacy instances as warnings without creating executable configuration. |
| Generic advanced actions | Retired by product decision on 2026-09-14. Raw custom action definitions and legacy advanced-policy references are absent from composable schemas and cannot grant inherited capabilities. |

The scan does not establish that all external clients are ready. Dispatcher/enrolled grant mappings and external `.pi/autopod.json` consumers still need their concrete deployment migration report. The reviewed native settings change has package/build proof; live UI interaction is still unverified because the UI automation surface is unavailable in this session.

## Functional preservation gaps

Custom advanced actions and test pipelines are intentionally retired. The legacy profile reader retains their bytes for rollback/history while the old system exists, but conversion emits `CUSTOM_ACTIONS_RETIRED` and `TEST_PIPELINE_RETIRED` warnings and creates no executable composable representation. Their removal is no longer a functional-preservation gap.

Native Claude Goals and Sandbox Goals are also unavailable. Local native protocol and Docker tests are recorded separately in `2026-09-14-native-goal-observations.md`; they do not authorize or substitute for the real provider acceptance journeys.

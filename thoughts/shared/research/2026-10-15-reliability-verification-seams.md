# Reliability verification seams

Date: 2026-10-15. Campaign: R01. Source baseline: `1a089d1b`; campaign
commits through `7a4e0676` change documentation only. Three delegated RPI
researchers inspected the CLI, desktop and lifecycle boundaries. This artifact
describes existing behavior; it does not authorize a broad harness rewrite.

## Research question

Which existing seams can independently demonstrate executable behavior,
native UI behavior and recovery across an actual process boundary, without
using the operator's live configuration or claiming mocks are live proof?

## CLI

- `packages/cli/package.json:6` maps both binaries to `dist/index.js`.
  `src/index.ts:33` loads configuration before parsing actual argv at line 70.
  Rejected actions reach the process error handler at line 72.
- `turbo.json:9` makes tests depend on builds. Direct package Vitest invocation
  does not guarantee that the executable bundle is fresh.
- `packages/cli/src/config/config-store.ts:7` resolves configuration from
  `os.homedir()`. `auth/token-manager.ts:16` uses the same home for the dev token;
  for a loopback URL it reads that token before cached credentials at line 38.
- Credential/MSAL fallback files also use the temporary directory, namespaced
  by a hash of the config path (`config/credential-store.ts:23`,
  `auth/msal-cache.ts:14`). Auth environment overrides are defined in
  `auth/auth-config.ts:22`. An isolated child must account for these inputs.
- `commands/daemon.ts:10` provides an unauthenticated health command with URL
  override. `commands/pod.ts:386` implements list through normal config/token,
  HTTP and renderer paths.
- `commands/pod.test.ts:104` and `commands/files.test.ts:7` use actual ephemeral
  loopback HTTP servers, but run Commander in-process. They do not establish
  built-binary imports, process exit, stream flushing or child environment use.
- `commands/pod.ts:671` opens the follow WebSocket directly. Close exits zero
  at line 696, error exits one at 697, SIGINT exits zero at 702. There is no
  reconnect or injectable timing in that implementation. `utils/id-resolver.ts:14`
  accepts full IDs without a preliminary list call.
- `utils/remote-terminal.ts:38` has injected connection/stdin/stdout and
  idempotent settlement at line 84, with listener-cleanup tests. Logs do not
  currently use this helper.
- `api/client.ts:133` has no timeout configuration; the request at line 933 has
  no explicit deadline. `managed/transport.ts:93` has a separate fixed 60-second
  signal. A test watchdog is therefore not proof of a product timeout.

No built-CLI subprocess test was found. `e2e/package.json:8` is a placeholder;
its AGENTS instructions reserve that package for genuinely cross-package flows.

## Desktop model, transport and rendering

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift:14` accepts an injected
  URLSession. `Tests/AutopodClientTests/ReplyDecisionRetentionTests.swift:8`
  exercises ActionHandler, PodStore and DaemonAPI with URLProtocol responses.
  It verifies server decisions/status, not text entered into a real view.
- `PodStoreFleetTests.swift:72` holds REST while an event inserts a pod; its
  actor gate is at line 262. Its URLProtocol stopLoading at line 304 is empty.
- `EventStreamResyncTests.swift:9` directly invokes the resync handler; it does
  not drive a real socket disconnection/replay exchange.
- `Sources/AutopodClient/EventSocket.swift:46` accepts callbacks/token provider,
  but line 57 fixes the session to URLSession.shared. Inactivity/reconnect
  timing is internal at line 41. No local desktop HTTP/WebSocket test server
  was found in the inspected Tests/Tools paths.
- `Tools/ConfigurationPreview/ConfigurationPreview.swift:6` hosts an in-memory
  configuration editor. `Tests/AutopodUITests/ConfigurationEditorLayoutTests.swift:7`
  hosts real views in NSHostingView/NSWindow with optional PNG rendering.
  `VillageWebViewTests.swift:16` exercises actual WebKit with optional screenshots.
- `Tests/AutopodClientTests/LiveVillageConnectionTests.swift:11` is opt-in live
  daemon/socket/WebKit testing using existing credentials; it is not an isolated
  full-app action harness. No XCUIApplication harness was found.

## Desktop full-app isolation

- `Autopod/AutopodXcodeApp.swift:12` constructs ConnectionManager directly.
  `Sources/AutopodDesktop/Stores/ConnectionManager.swift:50` consumes a deep link
  or restores saved state. The deep-link path at lines 232/262 persists connections.
- `Sources/AutopodClient/DaemonConnection.swift:85` uses UserDefaults.standard;
  `KeychainHelper.swift:8` fixes the service to `com.autopod.desktop`. Changing
  a test bundle identifier alone does not isolate all credential storage.
- Local connections and token recovery read the real home dev token
  (`ConnectionManager.swift:70`, `:655`; `DaemonConnection.swift:57`).
- `Stores/LaunchRequestJournal.swift:6` accepts an explicit directory, but
  normal callers use home-directory defaults. `ConnectionTests.swift:119`
  temporarily changes/restores standard defaults, not a private app store.
- `scripts/install-desktop.sh:39` replaces `/Applications/Autopod.app`;
  this is an installation path, not a disposable test launcher.
- `Sources/AutopodUI/Views/Detail/OverviewTab.swift:23` holds reply text in
  view-local state; sendReply at line 1225 clears it before awaiting the action.
  Existing decision-retention tests do not prove view-draft retention.

Thus deterministic model tests and native rendering are established, while a
private full-app bootstrap remains unimplemented in the inspected sources.

## Daemon process and persistence boundaries

- `packages/daemon/src/runtimes/run-claude-cli.test.ts:201` already owns a real
  Node child, checks ignored SIGTERM followed by SIGKILL, and confirms ESRCH.
  Linux process-group termination is covered separately in
  `containers/docker-container-manager.test.ts:1277` under a platform gate.
- `pods/completion-journal.test.ts:57` and `pods/merge-journal.test.ts:492`
  reopen real disk databases and verify retained decisions, generation fences,
  unresolved merge admission and provider confirmation. They do not kill the
  host process. `managed/local-runtime.docker.test.ts:276` likewise reconstructs
  components/DB within one host process around real Docker state.
- `db/connection.ts:4` independently constructs SQLite with WAL, synchronous
  NORMAL, foreign keys and busy timeout. `db/migrate.ts:102` exposes migrations;
  `pods/pod-repository.ts:679` constructs actual durable journals.
- `pods/local-reconciler.ts:16` accepts repositories, container manager, event
  bus, enqueue callback, validation repository and logger explicitly. Importing
  the executable bootstrap is not required to use that boundary.
- `test-utils/mock-helpers.ts:107` imports Vitest; its database fixture is
  in-memory. It is not a plain Node child fixture. Root `package.json:25` already
  includes esbuild for a possible fixture bundle using production constructors.
- `index.ts:407` supports AUTOPOD_MOCK_DOCKER. However, DB_PATH alone does not
  isolate startup: it loads cwd dotenv (126), home secrets key (271), home dev
  token (325), and host configuration (755). Worktree defaults use home paths
  (`worktrees/local-worktree-manager.ts:518`). Background services start in
  index lines 966–1252; Azure activation is environment-driven at 568.
- Signal cleanup at `index.ts:1348` drains/tears down before closing SQLite.
  SIGKILL bypasses this; component recreation is a different claim.

## Existing container and provider gates

- `containers/native-goal-recovery.docker.test.ts:8` requires a cached fixture
  image identified by sha256 plus an explicit socket. It uses no network/mounts,
  resource limits and exact-container removal in finally at line 74.
- `managed/local-runtime.docker.test.ts:20` requires the managed fixture image
  (optional socket override). Its deterministic transport makes no live model
  request. It asserts actual Docker/network 404 on cleanup and removes only its
  recorded resources and temporary tree (lines 276–325).
- `managed/live-rpi.docker.test.ts:59` requires image, auth file, repository and
  model settings. It uses a temporary mirror/bare remote and a fixed normalizeTitle
  canary. Three stages each allow up to 20 requests, an observed-token limit of
  500,000, 480 seconds duration and 30-minute expiry. These are existing fixture
  bounds, not a budget selected for the campaign. Credentials stay in host
  transport; the code oracle clones the result bundle and executes assertions
  (314), and cleanup removes exact owned containers/networks (362).
- `managed/acceptance-config.ts:60` is a different, tightly scoped canary:
  exact sandbox/Codex binding, one read-only repository, one provider request,
  up to 180 seconds and one report artifact. Matching installation/account and
  no conflicting unfinished attempt are required at line 152.

## Current execution evidence and limits

The initial baseline passed package/native tests, lint, typecheck and secret scan
as recorded in the campaign research. No new test, provider call or app launch
was performed for this research. The Docker probe timed out; no container proof
is inferred. Existing mock, in-process and rendered-view tests retain their
specific boundaries rather than being described as whole-app acceptance.

## Planning inputs, separate from existing implementation

The narrowest CLI candidate is a fresh bundle launched as a child against an
ephemeral HTTP peer, with synthetic config/token, controlled child environment,
bounded output/deadline and explicit cleanup. A compact JSON list response can
prove config/auth/request/output/exit together without a provider. Follow failure
semantics require their own intended contract before tests freeze behavior.

A full desktop journey needs a planned private bootstrap for defaults, keychain
and token lookup, journals and controllable REST/WebSocket behavior. Existing
view rendering and model tests can provide narrower evidence immediately.

A narrow process candidate uses a parent-owned temporary disk DB and children
importing production constructors. The first child records a pending decision
and completion, then acknowledges an IPC barrier; the parent SIGKILLs and reaps
it. A second child reopens the DB and runs reconciliation with explicit recording
infrastructure. Assertions cover preserved decision/source identity, no duplicate
worker/cleanup, and integrity. This would prove OS-process persistence/recovery,
not full executable bootstrap, Docker/provider behavior or power-loss durability.

These are candidates for subsequent task-specific plans, not completed harnesses.

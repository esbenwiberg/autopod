---
date: 2026-10-15T19:27:43+02:00
researcher: Codex
git_commit: 1a089d1b83f660e7bef49089d458ead0f49c0553
branch: codex/reliability
repository: autopod
topic: "Current reliability, client behavior, and verification boundaries"
tags: [research, codebase, reliability, desktop, cli, validation]
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Research: Autopod reliability campaign

## Research Question

What currently implements the seven agreed areas: trustworthy desktop state,
desktop usability, interruption recovery, predictable CLI behavior, cross-client
contracts, testable orchestration boundaries, and performance/release confidence?
What can this environment actually execute to verify those behaviors?

## Scope and provenance

Research is against committed main revision `1a089d1b83f660e7bef49089d458ead0f49c0553`,
fetched on October 15. A dedicated managed worktree was created at
`/Users/ewi/.codex/worktrees/autopod-reliability/autopod`, branch `codex/reliability`.
The original checkout's `codex/dispatcher-local-integration` branch and its
uncommitted work were not used as the campaign baseline.

Three delegated research agents inspected desktop, CLI, and lifecycle code.
The coordinator cross-checked action handlers, CLI follow/transport, workflow
definitions, test configuration, replay-resync coverage, and the native Docker
recovery fixture. Manager inspection is targeted, not a claim of exhaustive
review of its approximately 19,000 lines. Historical September findings are not
treated as current defects without source verification.

## Summary

The daemon has durable completion and delivery machinery and substantial test
coverage. Desktop maintains separate REST health and event-stream state, merges
REST snapshots with newer events, and backfills after truncated replay. CLI
transport and event-follow behavior differ from the desktop. Cross-language
fixtures exist for selected contracts. Default CI and desktop workflows target
`main`; real Docker and provider tests are opt-in.

## Detailed Findings

### Desktop state and interaction

- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift:166`
  waits for approval acceptance and daemon events. At `:211`, Kill writes the
  local `killing` state before its request and retains that state on error.
  Pause at `:232` writes `paused` and writes `running` if the request throws.
  Reply at `:188` refreshes authoritative state after the response.
- `ActionHandler.swift:12` maintains one `pendingAction` value; the research
  search located no consumers outside the handler. General, preview, and
  creation errors have distinct storage.
- `packages/desktop/Sources/AutopodDesktop/Stores/ConnectionManager.swift:445`
  obtains connected state from health; `:459` polls every 30 seconds.
  `packages/desktop/Sources/AutopodClient/EventSocket.swift:96` separately
  opens its socket, marks connected before subscription acknowledgement,
  subscribes and requests replay. Its reconnect delay is capped at 16 seconds.
- `packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift:94` passes
  health-derived and socket-derived connectivity separately to MainView.
- `packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift:159` performs
  paginated fleet discovery and protects newer status/insertion revisions
  against an in-flight REST response. Failed discovery preserves visible pods.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift:154`
  reloads fleet and requested histories after truncated replay. Events are
  batched and bounded; history/live merges deduplicate persisted identifiers.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:194`
  preserves selectable tabs across pod changes. Its terminal remains mounted
  across tabs (`:314`). Several action sheets dismiss/clear drafts before the
  asynchronous action returns (`:444`, `:1253`, `:1672`).

### CLI transport and output

- `packages/cli/src/api/client.ts:933` supplies no explicit deadline/signal in
  its central request function. This is not a claim about undici defaults.
  A 401 performs a second token call and fetch; their errors share a catch.
  `updateFromBase` has another HTTP path (`:468`).
- `packages/cli/src/managed/transport.ts:67` is a separate, bounded transport
  using a 60-second AbortSignal and no automatic retry of mutations.
- `packages/cli/src/commands/pod.ts:664` opens a single subscription for
  `logs --follow`; it ignores protocol error messages and malformed JSON.
  Every close exits zero (`:696`); errors exit one and SIGINT exits zero.
  This function has no reconnect, cursor, or replay handling.
- `packages/cli/src/utils/error-handler.ts:25` emits human-readable stderr
  with mapped exit codes. Successful JSON output is command-specific;
  the managed bridge has its own machine-readable failure envelope.
- CLI tests use injected Commander/client seams and actual loopback HTTP
  listeners, including lost-response launch replay and rejected actions.
  No built `dist/index.js` subprocess acceptance test was found in the CLI
  test search. CLI Vitest resolves shared types from source rather than dist.

### Cross-client contracts

- `packages/shared/src/fixtures/composable-launch.json` is consumed by
  shared schema tests, CLI launch tests, and Swift
  `Tests/AutopodClientTests/LaunchConfigurationTests.swift:63`.
  It exercises nulls, false, arrays, and secret references.
- Desktop also has a shared Village projection fixture and real WebKit
  selection/update tests. These are selected contract fixtures, not evidence
  of a comprehensive response/event compatibility suite.

### Lifecycle ownership and persistence

- `packages/daemon/src/pods/pod-repository.ts:679` constructs completion,
  execution, retry, deletion, publication, delivery, and merge ledgers. Its
  after-insert effects (`:738`) wait for the outer transaction and recheck
  persisted execution identity.
- `packages/daemon/src/pods/pod-manager.ts:1361` defines injectable runtime,
  container, worktree, validation, event and credential boundaries. Its event
  consumer (`:11549`) captures generation/container/provider/source identity;
  completion (`:12195`) retains pending human decisions and source evidence.
- `packages/daemon/src/pods/completion-journal.ts:17` persists settlement and
  decisions independently of in-memory promises. Identical duplicate replies
  preserve the first receipt; stale generations and conflicting replies fail.
- `packages/daemon/src/pods/merge-journal.ts:72` records source-bound intent,
  admission and provider observations. Ambiguous requests block repeat mutation
  admission until reconciled.
- `packages/daemon/src/pods/reconciliation-ownership.ts:4` retains resources
  if execution/deletion ownership is unresolved or evidence cannot be read.
- Existing extracted responsibilities include `polling-coordinator.ts`,
  `workspace-checkpoint-controller.ts`, `validation-ownership.ts`,
  `interactive-completion-coordinator.ts`, and local/sandbox reconcilers.
- `completion-journal.test.ts:57`, `merge-journal.test.ts:492`, and
  `task-retry-ledger.test.ts:73` exercise real SQLite close/reopen persistence.
  Lifecycle e2e uses real repositories and mocked external infrastructure.
  Manager tests inject stale ownership, delayed operations, and extraction
  failure; those are not OS-process daemon-kill or actual full-disk proofs.
- No general daemon OS-process crash runner was identified in the searched
  lifecycle/scripts/workflow paths. That is a bounded search finding.

### Verification entry points

- Root `package.json:8` orchestrates builds/tests plus script tests through
  pnpm/Turbo. `e2e/package.json:8` remains an echo-only placeholder.
- `packages/daemon/vitest.config.ts:8` can auto-exclude a list of database
  tests when native SQLite is unavailable. Setting `SKIP_DB_TESTS=0` forces
  inclusion. The baseline run uses that setting explicitly.
- `packages/desktop/Package.swift:46` declares client/UI/desktop test targets.
  `swift test --package-path packages/desktop --no-parallel` runs them.
- `packages/desktop/Tools/ConfigurationPreview/ConfigurationPreview.swift:6`
  is a native in-memory editor fixture. Layout tests can capture PNGs using
  `AUTOPOD_CONFIGURATION_RENDER_DIR`; WebKit tests can capture with
  `AUTOPOD_VILLAGE_SCREENSHOT`.
- `packages/desktop/Tests/AutopodClientTests/LiveVillageConnectionTests.swift:11`
  is opt-in live REST/socket/WebKit validation, using an existing credential
  internally. It is not a pod-creation or full-app navigation test.
- `packages/daemon/src/containers/native-goal-recovery.docker.test.ts:8`
  requires an explicit immutable image and socket. It tests recorded exec
  termination, child cleanup, preservation of an unrelated process, and
  idempotent repeat termination inside a real isolated container.
- `docs/managed-local-docker.md:99` describes the gated live-provider RPI
  canary. That canary is an existing software test; it is distinct from the
  HumanLayer RPI skill used to develop this campaign.

### CI and release entry points

- `.github/workflows/ci.yml:3` runs push/PR checks for `main` only.
- `.github/workflows/desktop.yml:3` also restricts push/PR to `main`, with
  desktop/workflow/renderer-script/lockfile path filters. Shared and daemon
  paths are not included. The workflow has manual dispatch.
- Desktop CI runs Swift tests, Village renderer checks, and an unsigned Xcode
  build. General CI builds/types/tests and scans secrets; dependency audit is
  explicitly non-blocking (`ci.yml:46`).
- `scripts/validate.sh` treats dependency audit failure as a failure. Its
  install path can fall back to a non-frozen install. It does not run Swift.

## Executed baseline

Commands executed against the clean baseline, with outputs retained locally
under `/tmp/autopod-reliability-*`. Pending checks are not passes.

- Node 22.23.3 and pnpm 9.15.4: frozen installation passed; lockfile unchanged.
  Host default Node is 24.21.0, so the campaign uses an explicit Node 22 runtime.
- Swift 6.3.3 / Xcode 26.6 available. `swift test --package-path packages/desktop
  --no-parallel` exited 0: 396 Swift Testing tests in 12 suites passed.
- `pnpm lint` exited 0 with 64 existing warnings; no fixes applied.
- Full `SKIP_DB_TESTS=0 pnpm test` under Node 22 exited 0: 7,103 Vitest tests
  passed and 10 skipped; 15 Turbo tasks succeeded, including builds. Script
  suite reported 20 passes; deployment and cleanup script suites also passed.
  No skipped real-container/provider test is treated as live proof.
- `pnpm typecheck && pnpm secret-scan` under Node 22 exited 0: 11 Turbo
  typecheck/build tasks succeeded (five cached), and secret scan passed.
- Docker context is `desktop-linux`; an isolated server-version probe timed
  out after 12 seconds. No real pod/container proof has been claimed.
- GitHub CLI is authenticated for the repository. No credential contents were
  inspected or included in the research artifacts.

## Open Questions

- Docker server availability, live pod proof, rendered whole-app behavior, and
  long-running performance have not been demonstrated in this research pass.
- Current facts are sufficient to plan bounded verification/CI tasks; execution
  feasibility for real-container work must be established before that task runs.

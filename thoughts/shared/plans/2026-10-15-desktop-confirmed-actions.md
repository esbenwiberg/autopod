# R04a: retain confirmed desktop state during pause and kill

## Overview and authorization

Correct two existing action handlers that show a requested state as though the
daemon confirmed it. The user approved autonomous branch-contained RPI execution
and the Inline status wireframe. This first bounded slice establishes the state
truthfulness prerequisite; it adds no commands, layout, controls or capabilities.
All implementation/proof phases are authorized together under the campaign.

## Current state

See research/2026-10-15-desktop-confirmed-actions.md. ActionHandler.kill invents
killing before POST; pause invents paused and rolls back to running on failure.
A late error can overwrite an intervening daemon event. PodStore already merges
GET snapshots with protection for status events arriving during the fetch.

## Desired behavior

While pause/kill POST is held, retain the most recently observed pod status.
On rejected POST or transport failure, report the existing error and preserve
current state, including a newer event. On acknowledged POST, request a fresh
snapshot through the existing PodStore.refreshSession path; only observed state
changes the status. If refresh fails, keep the last observed state. Do not infer
that HTTP acknowledgement means the process is already paused or killed.

## Implementation scope

Production edits are limited to pause and kill in
packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift:
remove optimistic status writes and rollback; await refreshSession after a
successful API call. Preserve error mapping and action signatures. Do not change
PodStore merge logic, daemon endpoints, action eligibility, dependency versions,
connection bootstrap, notifications, journals or persistence.

Tests belong under packages/desktop/Tests/AutopodClientTests, which already has
all three required library dependencies. Use a purpose-built bounded synthetic
URLProtocol fixture and actual handler/store/API objects, not replacement action
logic. Use production detail view rendering only for the narrow observed-state
claim. No broad app fixture or target changes are required.

Pending command display, duplicate submission prevention, cross-connection
ownership, retained drafts and full application recovery are later R04 slices.
This task must not claim those behaviors are fixed.

## Phase 1 — reproduce and characterize

Before production edits, add deterministic tests for both actions. Hold POST with
a protocol receipt barrier; inspect state before releasing it. Include an initial
state other than running for pause so rollback-to-running cannot pass by accident.
Record baseline failure on the held-request assertion or late-failure event case.
Fixture gates have deadlines and cancellation/teardown that release pending work;
use unique synthetic host/request identity per case, an ephemeral session, literal
fixture token and no provider/home/credential access. Invalidate owned sessions.
Teardown releases or cancels all held requests, awaits owned action tasks, and
invalidates the session. stopLoading prevents late callbacks. Detach and close
owned native windows. Do not use sleeps as a substitute for request/response barriers.

## Phase 2 — repair and prove behavior

For both pause and kill cover:

- POST pending: last observed status retained.
- POST rejection: error surfaced; current status retained.
- Transport failure: same retention, one POST and no implicit resend.
- Event changes state while POST pending, then POST fails: event wins.
- POST succeeds and GET is held: no fabricated transition; the subsequent
  decoded server snapshot supplies paused/killing/killed as appropriate.
- POST succeeds but GET fails: retain the observed status.
- Event arrives while post-acknowledgement GET is held, then stale GET resolves:
  preserve the newer event through existing status revision protection. This
  covers events after GET starts; no new monotonic ordering for earlier events,
  deletion or connection switches is claimed.

Assert method/path and request counts as well as final state/error. Preserve pod
identity, branch and unrelated fields. Prove normal pendingAction cleanup, without
claiming to solve its existing global concurrency limitation.

Native proof: host actual DetailPanelView on Overview in NSHostingView/NSWindow
with an observing PodStore and real handler.actions. Invoke the production action
closure, capture initial/held/rejected/confirmed states from that live composition,
and inspect PNGs. Include a newer-event/late-failure state. Use synthetic content;
no production connection, auth, notifications or external navigation. A fixture
method invocation is not proof of button activation; report the boundary honestly.
Rejected-state images prove retained status, not AppRootView's error alert.
If actual render capture is unavailable, retain the state-test result but mark
the visual claim unproven, not complete. No new visible layout is authorized.

## Phase 3 — review and integration

Run focused tests (exact filter recorded in evidence), the full Swift test suite
and build AutopodDesktopExe. Use the normal repository secret scan and
git diff --check. Record test counts/skips and any existing warnings. An independent
reviewer examines final diff, reruns affected tests and inspects native evidence
before PR creation. PR base codex/reliability; wait for hosted checks, merge only
into campaign, then run relevant integrated checks.

No manual user check is required for these observable state contracts. Automated
render review is not human acceptance. Existing Inline selection remains the
design checkpoint for later pending-state presentation.

## Acceptance

- [x] Old optimistic/rollback behavior reproduced as a failing regression.
- [x] Pending, rejected, lost-response and newer-event state retention proven.
- [x] Acknowledgement alone does not change status; successful GET/event does.
- [x] Failed/stale refresh behavior and no implicit POST resend proven.
- [x] Actual native composition captures inspected with boundary stated.
- [x] Full Swift/build/secret/whitespace checks pass.
- [x] Independent review before PR; hosted and integrated checks recorded.

## Compatibility, performance and rollback

No API/schema migration. Successful pause/kill adds one existing GET to refresh
observed state. Operators may see the prior state until daemon confirmation;
that is the intended correction. Errors retain the current standard presentation.
Revert the bounded handler edits to restore prior behavior if required.

## Status

Implemented in `codex/reliability-desktop-actions` from
`afbaa5dd8dac46e7a2a424ad452f968865700c5c`. Independent final review, PR checks
and integration remain coordinator-owned. No PR has been opened by the worker.

## Execution evidence (2026-10-15)

Only `ActionHandler.pause` and `kill` changed in production: three optimistic or
rollback assignments were removed, and each successful POST now awaits the
existing `refreshSession`. No view source, model lifetime, action signature,
connection/bootstrap or storage code changed.

The worker started without a Swift build directory, built the package from source,
and ran the rejection regression before editing ActionHandler. Four parameter
cases produced seven assertion failures: held pause was paused, rejected pause
was running (including after a complete event), and held/rejected kill was killing.
The successful native build preceded this intentional behavioral failure.

The final fixture uses unique `.invalid` hosts and an ephemeral URLSession with
an intercept-all, fail-closed URLProtocol. Every request has a ten-second failure
deadline; receipt barriers have a five-second deadline. Normal evidence asserts
that no deadline fired. Response/cancellation callbacks share a lifecycle lock;
teardown closes the peer, cancels and awaits action tasks, invalidates the session,
and unregisters the peer. A separate test cancels a held request and verifies a
late success response cannot cause a GET or status change. Native windows are
detached and closed on every path.

Evidence is retained locally in ignored `.autopod-data/reliability/r04a/`:

| Check | Command | Result / evidence |
|---|---|---|
| Baseline regression | `swift test --package-path packages/desktop --no-parallel --filter confirmedActionRetainsStateOnRejection` | Expected exit 1, four cases / seven state failures; `baseline.log` |
| Final focused behavior and rendering | `AUTOPOD_ACTION_RENDER_DIR="$PWD/.autopod-data/reliability/r04a/native" swift test --package-path packages/desktop --no-parallel --filter 'confirmedAction\|confirmedKill'` | Exit 0; six Swift Testing functions, 20 total parameter/single invocations; `focused.log` |
| Full native suite | `swift test --package-path packages/desktop --no-parallel` | Exit 0; 13 XCTest tests plus 402 Swift Testing tests in 12 suites; opt-in LiveVillageConnectionTests suite/test skipped; `swift-tests.log` |
| Executable build | `swift build --package-path packages/desktop --product AutopodDesktopExe` | Passed; `swift-build.log` |
| Secrets | `npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm secret-scan'` | Passed; `secret-scan.log` |
| Whitespace | `git diff --check` | Passed |

The initial build reported existing warnings about an unused AppRootView
profileStore capture and an unnecessary await in DaemonAPITests; neither file
changed. A dependency cache maintenance-lock warning was followed by successful
dependency resolution/build. Final focused and full-suite runs passed.

The worker inspected all 12 native PNGs under `native/`: for each of pause/kill,
initial, held and rejected show running; confirmed shows paused/killed respectively;
newer-event and late-failure both show complete. The production header actions and
Overview status badge are visible at 900×760 with no observed clipping. Tests
await the view's lifecycle status observation before capturing its actual pixels.

This establishes the narrow production action → API → store → DetailPanelView
composition. It does not prove button activation, AppRootView's error alert,
application startup, live HTTP/WebSocket behavior, daemon-side execution,
pending-action presentation, duplicate suppression, retained drafts or recovery
across connection switches. Event races use the production store's event mutation
seam; the existing GET-start revision fence is exercised without changing it.

## Final integration proof

PROVEN for the bounded action/API/store/detail composition at worker
3918b6dd6c4b1190d8946a8018cfbff0767981e4. Coordinator reviewed all changed
files, independently ran all20 focused invocations, and inspected12 worker
native captures plus4 independent rerenders before PR421. Hosted CI38786588214
and Desktop38786588153 passed, including the Xcode app build. PR421 merged into
codex/reliability at2ff947ea. The same six test functions/20 invocations passed
on the integrated tree; evidence r04a-integrated.log. Native and local evidence
retained in .autopod-data/reliability/r04a/. Limitations above still apply; this
is automated proof, not human acceptance or full-app/live-daemon validation.

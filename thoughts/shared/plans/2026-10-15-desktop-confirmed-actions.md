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

- [ ] Old optimistic/rollback behavior reproduced as a failing regression.
- [ ] Pending, rejected, lost-response and newer-event state retention proven.
- [ ] Acknowledgement alone does not change status; successful GET/event does.
- [ ] Failed/stale refresh behavior and no implicit POST resend proven.
- [ ] Actual native composition captures inspected with boundary stated.
- [ ] Full Swift/build/secret/whitespace checks pass.
- [ ] Independent review before PR; hosted and integrated checks recorded.

## Compatibility, performance and rollback

No API/schema migration. Successful pause/kill adds one existing GET to refresh
observed state. Operators may see the prior state until daemon confirmation;
that is the intended correction. Errors retain the current standard presentation.
Revert the bounded handler edits to restore prior behavior if required.

## Status

Root-prepared task plan independently reviewed by research_desktop with no
blocking findings. Fixture cleanup, revision-boundary and error-alert claim
clarifications incorporated above. Ready for worker execution under standing
authorization and the user's Go.

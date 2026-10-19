# Autopod reliability campaign — final report

Status: PROVEN for the scoped campaign at `f587fa075965245e53049b7367cb317eb8a0c55b`. Independent final evidence review found no actionable issues; all selected task gates are closed.

The work is contained in `codex/reliability`. All 20 task PRs followed
research and a resolved plan, independent review before opening, hosted
checks, and affected integration checks. The user selected the Inline status
wireframe before visible changes. No production deployment or main merge occurred.

## What changed and how it was established

| Area | Result | Review and proof |
|---|---|---|
| Trustworthy desktop state | Pause/kill keep confirmed state while requests are pending; duplicate controls share owned work; stale REST/events and old connection handlers cannot publish into newer state. | PRs [#421](https://github.com/esbenwiberg/autopod/pull/421), [#425](https://github.com/esbenwiberg/autopod/pull/425), [#427](https://github.com/esbenwiberg/autopod/pull/427), [#431](https://github.com/esbenwiberg/autopod/pull/431), [#432](https://github.com/esbenwiberg/autopod/pull/432), [#435](https://github.com/esbenwiberg/autopod/pull/435); private held transports, native controls, source-switch and late-completion races. |
| Existing workflows | Inline pending/error states and current command-palette keyboard navigation; replies retain their exact question and draft through view changes and reconnects. | PR [#433](https://github.com/esbenwiberg/autopod/pull/433) and PR [#436](https://github.com/esbenwiberg/autopod/pull/436); native field-editor typing, Return and actual option/approval button activation. |
| Interruption recovery | Pending decisions survive actual process death; old artifact-copy/cleanup cycles cannot mutate a resumed worker cycle. | PRs [#419](https://github.com/esbenwiberg/autopod/pull/419), [#423](https://github.com/esbenwiberg/autopod/pull/423); SIGKILL/reopen with real SQLite, held-copy/cleanup public-control regressions. |
| CLI predictability | Unexpected log-stream closure produces failure instead of false success; intentional Ctrl-C completes cleanly; rejected authentication responses are disposed before retry. | PRs [#417](https://github.com/esbenwiberg/autopod/pull/417), [#420](https://github.com/esbenwiberg/autopod/pull/420), [#422](https://github.com/esbenwiberg/autopod/pull/422); fresh built executable subprocesses, private HTTP/WebSocket peers and cleanup assertions. |
| Shared contracts | Pod-list responses retain valid pending decisions; desktop uses exact decision IDs and rejects stale resolution/REST replacement. | PRs [#426](https://github.com/esbenwiberg/autopod/pull/426), [#432](https://github.com/esbenwiberg/autopod/pull/432); real Fastify/SQLite responses and shared TypeScript/Swift fixtures. |
| Testable orchestration | Artifact finalization is extracted behind a typed boundary while manager admission, cycle ownership and durable transitions remain intact. | PR [#434](https://github.com/esbenwiberg/autopod/pull/434); unchanged characterization before/after extraction, real private file copying, journal ordering and 708 affected integrated tests. |
| Release confidence | Campaign CI routing, historical upgrade/backup/restore, measured fleet traversal and one bounded real Azure sandbox qualification. | PRs [#416](https://github.com/esbenwiberg/autopod/pull/416), [#424](https://github.com/esbenwiberg/autopod/pull/424), [#428](https://github.com/esbenwiberg/autopod/pull/428), [#429](https://github.com/esbenwiberg/autopod/pull/429); real database round trip; 21 traversals across 100/1,000/10,000 pods at the recorded snapshot; actual sandbox create/exec/file/kill with teardown independently checked at its recorded source. |

## Combined verification

JavaScript source inputs were frozen at `74f55787`; all 4,417 tracked inputs
(excluding thoughts artifacts and desktop Swift files) match the final source, including tracked membership.
Pinned Node 22/pnpm 9.15.4 frozen installation passed. The six uncached pipeline
stages passed: lint, build, typecheck, test, dependency audit and secret scan.
There were 7,170 passing Vitest tests across 486 files, 10 skipped tests across
five files, 35 passing Node script tests, and passing deployment/provenance/cleanup
shell checks. Turbo reported 15 successful tasks and zero cache hits. Audit returned
“No known vulnerabilities found.” Lint passed with 82 warnings.

The first two runner attempts failed because nested npx inherited incompatible
options and then selected system Node 24 against Node 22 SQLite binaries. Both
failures are retained. A reviewed ignored runner executed the exact six commands
with the pinned runtime; product scripts and dependencies were not changed to
make validation pass.

On merged source `f587fa07`, root ran the full serialized Swift suite: 495 passing
functions / 651 executions across 27 suites, plus 13 XCTest cases; one existing
live-daemon function/suite skipped. The executable build passed. Root regenerated
and inspected all 43 reply/decision captures, preserving the actual-sheet vibrancy
limitation and supplementary production-component appearance evidence. Final
secret scan passed and all 4,417 JavaScript input hashes/membership matched.

The final PR head `c7303915` passed [Linux CI](https://github.com/esbenwiberg/autopod/actions/runs/38815098480)
and [Desktop CI](https://github.com/esbenwiberg/autopod/actions/runs/38815098505),
including Swift 6.1.2 tests, renderer contracts and the unsigned Xcode app build.
Its first hosted build exposed a Swift-version callback annotation issue; an
independently reviewed explicit Sendable annotation corrected it, followed by
local and hosted reruns. The failed build is retained.

Closure commits modify documentation only; product evidence is tied to the
source revisions above. Main remains `9978fb5e`.

## Evidence and limits

The [campaign ledger](2026-10-15-reliability-campaign.md) links every task and
integration checkpoint. The [final qualification plan](2026-10-15-campaign-final-qualification.md)
records the combined gates. Local raw logs, PNGs, source hashes and receipts are
retained under `.autopod-data/reliability/`, with combined evidence under `final/`.
Those ignored artifacts are local; the committed plans and GitHub checks are durable
review references, not a claim that all raw evidence was uploaded.

Native proof covers production components composed with real stores/actions and
private transport. It is not full-app account setup or human acceptance. Reply
drafts last for the app process; the existing API has no expected-decision CAS,
so a server question may still change between preflight GET and POST. Failed POSTs
remain unconfirmed and are never automatically replayed.

Default Docker/live-model fixtures and the macOS-inapplicable Linux process-group
case were skipped. The e2e package command is a placeholder. The one real sandbox
run exercised adapter boundaries, not a model-driven full pod journey or firewall
enforcement; its initial provider inventory was empty. Fleet measurements are
bounded warm-route observations, not a latency SLA. Dependency audit is a result
at the time of the run, not a general security certification.

Final audit preserves source limits on those earlier experiments: the sandbox
receipt was produced at `44e4f39f` (qualified worker head `330fc51e`); later main
added optional runtime Zod `contextFiles` validation in one of its 142 recorded
inputs. Fleet measurements belong to `1e179dc1`; the route, repository, benchmark
and lockfile are unchanged, but later main added managed-only migrations 208/209
and other broad-manifest inputs changed. These are valid historical observations,
not claims of a byte-identical final live bundle or final-head timing measurements.
The later main checkpoint and final combined tests establish tested compatibility.

## Task RPI plans

- Foundation: [CI routing](2026-10-15-reliability-ci-routing.md), [real CLI proof](2026-10-15-cli-executable-proof.md), [process crash](2026-10-15-process-crash-proof.md), [native sandbox](2026-10-15-native-sandbox-qualification.md).
- CLI: [log following](2026-10-15-cli-log-follow.md), [authentication response cleanup](2026-10-15-cli-auth-response-cleanup.md).
- Desktop: [confirmed actions](2026-10-15-desktop-confirmed-actions.md), [socket lifetime](2026-10-15-desktop-socket-lifetime.md), [REST lifetime](2026-10-15-desktop-rest-lifetime.md), [inline controls](2026-10-15-desktop-inline-controls.md), [connection ownership](2026-10-15-desktop-connection-ownership.md), [reply drafts](2026-10-15-decision-reply-drafts.md).
- Contracts/navigation: [decision responses](2026-10-15-decision-response-contract.md), [decision identity](2026-10-15-desktop-decision-identity.md), [palette keyboard](2026-10-15-command-palette-keyboard.md).
- Orchestration: [cycle fencing](2026-10-15-artifact-cycle-fence.md), [artifact extraction](2026-10-15-artifact-finalizer-extraction.md).
- Qualification: [upgrade/restore](2026-10-15-upgrade-restore-roundtrip.md), [fleet traversal](2026-10-15-fleet-list-qualification.md), [final combined checks](2026-10-15-campaign-final-qualification.md).

Final independent review verified 94 combined evidence hashes, all 4,417 JavaScript
inputs and tracked membership, all 23 R04f source hashes against the tested merge,
raw test/skip counts, hosted-source equivalence, all earlier closed gates and branch
containment. No actionable finding remained. Review was read-only; root performed
the runtime checks and visual inspections. Completed worker build caches were
cleaned after source and evidence retention. No required work remains in this
finite campaign.

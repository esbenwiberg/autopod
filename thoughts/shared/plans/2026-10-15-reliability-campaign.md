# Autopod reliability campaign

## Overview

Improve the seven agreed areas without expanding product capabilities:
trustworthy desktop state, readable existing workflows, interruption recovery,
predictable CLI behavior, shared contracts, testable orchestration boundaries,
and performance/release confidence.

This is the campaign coordination plan. Individual tasks receive their own RPI
research and implementation plans. Only tasks with resolved scope and explicit
checks are ready for execution; later workstreams are a prioritized backlog,
not permission to perform speculative rewrites.

## User requirements and standing authorization

Recorded from the October 15 conversation:

- Codex and subagents drive the entire campaign and minimize user involvement.
- Use RPI for every task and review the work before opening its PR.
- Use one long-lived branch; workers branch out from it.
- Show wireframes before changing any visible UI.
- Large restructuring, particularly pod-manager, must be testable.
- Independently verify and validate completed work.
- Work within the branch is preapproved, including real pods for testing.

The user's authorization governs routine technical phase progression,
delegation, commits, pushes, task PRs, fixes, and integration into the campaign
branch. The RPI research/plan/implementation separation and artifacts remain.
No repeated technical approval question is needed. Product/design choices stay
with the user; render proposed wireframes before their UI implementation. An
agent-operated UI check is automated evidence, never a claim of human signoff.

Real-pod validation is separate from the RPI skill's development workflow. It
uses the existing reviewed provider/account/repository configuration, bounded
resources, isolated test data, and recorded teardown; missing bindings are
resolved from existing configuration without guessing secrets or switching
providers. Main/production rollout is outside this branch-contained campaign.

## Current State Analysis

Baseline: `1a089d1b83f660e7bef49089d458ead0f49c0553`, current committed main when
the campaign worktree was created. See
`thoughts/shared/research/2026-10-15-reliability-campaign.md`.

The code already includes durable completion/merge/retry ledgers, generation
fences, event replay, REST merge protection, and selected cross-language
fixtures. Tests exercise repository restart and mocked boundary failures.
The executed baseline checks passed; Docker server probing timed out. Default
workflow branch filters do not include the requested integration branch.

## Desired End State

Three representative operator journeys anchor acceptance:

1. Leave work running: it progresses or stops with a durable, intelligible
   reason, preserving work and unresolved decisions.
2. Investigate a failure: existing clients show confirmed state, preserved
   work, relevant evidence and an appropriate existing recovery action.
3. Lose a connection during an action: the outcome is reconciled, uncertain
   mutations are not repeated blindly, and clients do not invent success.

For each changed behavior, evidence identifies the tested revision, command,
asserted outcome, and limitations. The integration branch is considered ready
only after affected tests and cross-component scenarios pass together.

## Branch and worker protocol

- Integration: `codex/reliability` in its own managed worktree.
- Workers: `codex/reliability-<task>` from a recorded integration commit,
  each in a separate managed worktree. PR base is always `codex/reliability`.
- Coordinator owns scope, integration, conflict resolution, test results,
  durable task status, and final evidence. Implementers do not self-certify.
- One implementation owner at a time for pod-manager, migrations, shared
  schemas, and other overlapping files. Parallelize independent seams.
- Before PR: independent review of intended behavior, actual diff, acceptance
  evidence, regressions and remaining risks. Fix valid findings and re-review
  affected changes. Open PR only after this review.
- Before integration: inspect hosted checks; distinguish missing/skipped/failed
  checks. Merge into the campaign branch, then verify affected integrated flows.
- Fetch main periodically and integrate at checkpoint boundaries, with checks
  after conflict resolution. No force pushes to the integration branch.
- Preserve unrelated working changes. Archive worker worktrees only after
  integration/evidence retention. No direct main merges or hosted deployment.

## RPI task lifecycle

Research artifact -> resolved plan -> implementation on worker branch ->
prove-work evidence -> independent review -> PR -> integration checks.

Every worker receives the user requirements, exact base SHA, task research/plan,
applicable AGENTS instructions, allowed file scope, exact checks, and ownership.
If evidence contradicts the plan, record Expected / Found / Why it matters /
Proposed adjustment. The coordinator resolves routine in-scope technical
adjustments and updates artifacts. Ask the user only for an unresolved product
choice or missing authority that repository evidence cannot establish.

## Waves and task ledger

| ID | Task | Dependencies | Status / next action |
|---|---|---|---|
| R00 | Existing CI covers campaign PRs and contract paths | Baseline | Complete: PR #416 passed hosted checks and merged into campaign at 980e0b86 |
| R01 | Verification harness feasibility and deterministic fixtures | R00 | R01a complete (PR #417); R01b complete (PR #419, cf8c6663), integrated43tests passed; R01c complete (#429,f818a8b3), live proof and hosted/integrated checks passed |
| R02 | Desktop connection/action wireframes | Campaign research | Wireframes shown; user selected Inline status; carry direction into R04 plan |
| R03 | CLI transport and log-follow reliability | R01 | R03a complete (#420); R03b complete (#422,913c0622); hosted+integrated proof passed |
| R04 | Desktop confirmed state, pending actions, draft retention | R01, R02 shown | R04a complete (#421); R04b complete (#425,173d3450); R04c complete (#427,80fc8158; integrated18tests at43a5fad2 after fixture PR430); R04d complete (#431,1ace904a), hosted/integrated32 tests and47 capture matches; R04e connection ownership implementing reviewed planf8693f23; draft retention follows |
| R05 | Shared response/event contract scenarios | R00, R01 | R05a complete (#426,98b9d912); R05b complete (#432,be22402d); independent47tests/six captures, hosted and integrated47tests passed |
| R06 | Lifecycle interruption scenarios and first extraction | R01 | R06a complete (#423,5cc8fbc6); R06b independently reviewed, PR434 hosted checks pending |
| R07 | Existing navigation/readability/keyboard polish | R02, R04 | R07a complete (#433,96783185); independent/hosted/integrated12functions and14 capture matches; literal mouse proof excluded |
| R08 | Representative performance, upgrade and restore qualification | R01; affected changes integrated | R08a complete (#424,c1faba3a), hosted+integrated roundtrip passed; R08b complete (#428,04dabd6a), independent reproduction and hosted/integrated checks passed |

The ledger above is current; execution checkpoints below preserve chronology.
Implemented slices each have their own reviewed RPI plan and proof. Remaining
reconnect outcomes, reply drafts, orchestration extraction and navigation work
still require bounded plans from current source evidence. A workstream heading
is not an executable specification or permission for a speculative rewrite.

## Verification strategy

### Baseline and regression

Use Node 22/pnpm 9.15.4, frozen installation and `SKIP_DB_TESTS=0`. Record native
SQLite availability, real exits, skipped suites and existing warnings. Run
targeted checks per task and appropriate broader checks at integration. Avoid
unrelated repeated full-suite runs when no affected code changed.

### Boundary evidence

- CLI: built binary in a subprocess with private config, ephemeral loopback
  server, controlled responses/socket disconnects, output and exit assertions.
- Desktop: injectable server/session tests, actual app/NSHostingView/WebKit
  rendering as appropriate; inspect screenshots for each materially changed
  state. Full-app claims require actual integrated app interaction.
- Daemon: real SQLite and temporary Git repositories, deterministic event/time
  controls, cancellation/late-result/duplicate/restart scenarios. OS-process
  crash claims require process termination and restart, not manager recreation.
- Real pods: only when Docker or reviewed sandbox routing is proven available;
  record image/source identities, provider request bounds, artifact/source
  results and actual resource teardown. A skip or timeout is not proof.
- Contracts: shared fixtures decoded/interpreted by both clients and checked
  against daemon outputs. Keep lifecycle eligibility authoritative on daemon.
- Performance: reproducible fixture size, hardware/toolchain, warm/cold state,
  repeated timings and memory/idle observations before and after.
- Upgrade: disposable historical database fixtures, migration/data invariants,
  sampled restore and supported client compatibility; never mutate live data
  to obtain failure evidence.

Every task's prove-work verdict is PROVEN, PARTIALLY PROVEN, or FAILED. Attach
observable evidence for each material claim. Human preference/signoff remains
separate; do not convert automated screenshots into human acceptance.

## Large-refactor rules

Before an extraction, specify current inputs, outputs, owned resources, durable
records, cancellation/ownership fences and error behavior. Establish behavioral
tests at the boundary. Extract one responsibility in a reviewable diff, retaining
existing identity checks and receipts. Keep intentional behavior changes apart
from mechanical movement. Compare observable behavior and run interrupted cases
before and after. A reduced line count alone is not acceptance.

## UI checkpoint

User decision: after viewing the published interactive wireframes, the user said
"Inline is best i think." Use Inline status for R04: action controls near the pod
heading, pending requests distinct from confirmed pod state, and drafts retained
through reconnects. The wireframe-before-visible-change checkpoint is satisfied
for this direction. This records a design preference, not completed implementation
or native-app validation. Later navigation changes still need their own wireframes.

Published preview: https://autopod-reliability-wireframes.esbenw309505.chatgpt.site

R02 presents wireframes before any visible change, covering existing task state,
pending command, lost connectivity, rejected action, confirmed recovery and
preserved reply draft. Later navigation changes receive their own batch. Show
evidence already available in the model; do not fabricate certainty about source,
validation or action completion. Broader product choices require user direction.

## Performance Considerations

No optimization is authorized solely by intuition. Initial representative sizes
and thresholds are chosen during R08 research and recorded before implementation.
The macOS CI path expansion in R00 intentionally increases contract coverage.

## Migration Notes

No migration in the foundation task. Future persistence changes require unique
migration prefixes, historical fixture verification and explicit rollback/source
preservation notes in the task plan. Keep production deployment separate.

## References

- Campaign research: `thoughts/shared/research/2026-10-15-reliability-campaign.md`
- First executable plan: `thoughts/shared/plans/2026-10-15-reliability-ci-routing.md`
- Workflow skills: `/Users/ewi/.codex/skills/rpi/SKILL.md` and
  `/Users/ewi/.codex/skills/prove-work/SKILL.md`.

## Progress and exact next action

Campaign branch published at `2274e78c`; research synthesized; executed baseline
tests/lint/typecheck/secret-scan passed. Independent plan review found no R00
blockers. R00 worker commit `9592eee6` passed independent pre-PR review and
rerunnable local proof (60 routing cases, eight before/after assertions, parsed
workflow preservation, scope and whitespace). PR #416 targets this branch:
https://github.com/esbenwiberg/autopod/pull/416. Hosted CI and desktop checks
started; integration waits for their result. R01 feasibility research across CLI,
native desktop and lifecycle boundaries is recorded in
`thoughts/shared/research/2026-10-15-reliability-verification-seams.md`.
The first executable harness plan is `2026-10-15-cli-executable-proof.md`;
independent plan review clarified private environment probes, precise permission
error behavior, and waiting for subprocess stream closure. Implementation has
not started. Native full-app isolation requires a separate planned bootstrap;
model/view tests do not establish that isolation.

Baseline logs are copied from /tmp into the integration worktree's ignored
`.autopod-data/reliability/baseline/`. R00 local script/JSON evidence is also
retained in `.autopod-data/reliability/r00/` before any worker archival.

R02 proposals are in `2026-10-15-desktop-state-wireframes.html`: Inline status
and Action panel, with connected, pending pause, disconnected outcome, rejected,
confirmed pause, pending resume and retained reply scenarios. Browser interaction
confirmed pending actions preserve the last confirmed status and draft text
survives switching layouts. Screenshots inspected at desktop and 360px widths;
no browser console errors observed. This verifies the proposal only, not native
app behavior. No visible product code has changed. The user selected Inline status
after viewing the published preview; it retains more space for existing details.

Independent campaign-plan review confirmed the requirements and bounded first
task, and corrected baseline wording to distinguish skipped live checks and
unexecuted Xcode/full-app proof from passing local test suites.

## Execution checkpoint — October 15

R00 and R01a are merged into codex/reliability after independent pre-PR review
and successful hosted checks. R01a also passed a fresh integrated build and its
three executable tests. Evidence lives in `.autopod-data/reliability/r01a/` and
`r01a-integrated.log`. R01b actual SIGKILL/reopen proof is in worker validation.
R03a log-follow research and independently reviewed plan are ready for execution
on a new worker forked from the campaign branch. The Inline status selection
remains the desktop direction; its native isolation and action-state plan is
still being narrowed before visible product edits. Earlier progress entries
are historical snapshots, superseded by this checkpoint.

R03a is complete: PR420 passed independent pre-PR review and hosted CI, merged
at20b7652b; fresh integrated build plus17 executable/lifecycle cases passed.
R01b PR419 awaits hosted daemon/desktop checks after independent process proof.
R04a worker implements the reviewed confirmed pause/kill plan with native
component-composition evidence. Artifact-finalization ownership research is
recorded separately; no manager extraction is authorized by that map alone.

R01b is now merged atcf8c6663 after all hosted checks, with43 integrated tests
passing. R04a independently reviewed at3918b6dd;20 focused invocations passed
and native captures inspected; PR421 awaits hosted checks. R06a artifact cycle
fence has a reviewed implementation plan incorporating cleanup's internal
ownership assertions. R03b selects rejected401 response disposal as a bounded
CLI transport repair; a universal timeout policy remains deliberately unselected.

R04a merged at2ff947ea after general CI and native test/Xcode build passed;
20 focused invocations passed on integration. R03b independently reviewed at
dbe28efa and fresh built CLI retry proof passed; PR422 awaits hosted checks.
R06a full daemon suite passed6091tests plus703 targeted tests; independent final
review is running. Desktop reply acceptance/connection lifetime research is
complete and will inform the next bounded plan; safe replay cannot be inferred
from a failed HTTP response.

R03b merged at913c0622 after hosted CI passed;25 affected cases passed after a
fresh integrated build. R06a independent review found no actionable issues and
reran all3 public-control regressions plus703 affected tests before PR423.
Socket ownership research now precedes pending-action UI work: reconnect and
disconnect must have reliable lifetimes before presenting their outcomes.

R06a merged at5cc8fbc6 with hosted general/native checks and704 integrated tests
passing. R04b socket-lifetime worker branches from3426702d; independent plan review
added overlapping old/new token-provider lifetime proof and connect actor-entry
cancellation. R08a worker at22f88734 passed67 qualification tests and is in
independent final review. Live validation availability research records Docker
timeout and hosted revision mismatch; no real-pod proof is claimed. Worker
archival attempts for R00/R01a were refused because the worktrees are protected
by a pinned task/workspace; source and evidence are retained, no forced deletion.

R08a merged atc1faba3a after independent review and successful general/native
hosted checks. Its real historical database upgrade/backup/restore/reupgrade test
passed again after integration. R04b independent review inspected final source
and reran15 native socket/control/resync/dedupe cases at3e97aed5 before PR425;
all passed, with peer/session/listener teardown observed. R05a baseline reproduces
list serialization dropping a valid escalation envelope that detail preserves;
its bounded repair and cross-client contract fixtures are in implementation.

R04b merged at173d3450 after hosted general/native checks;21 affected native test
functions passed again on integration. R05a independently reviewed atb99dab09,
with real SQLite/Fastify, fresh-built CLI and Swift contract proof rerun before
PR426. R01c's no-model native qualification harness is being prepared, with a
coordinator review gate before its single live create. R04c targets superseded
PodStore REST responses; it explicitly does not claim complete daemon-data
separation or immediate disconnect fencing.

R05a merged at98b9d912 after hosted general/native checks. Integrated real route
and helper22tests, fresh-built CLI2cases and Swift2contract functions passed.
R04c preserved its failing connection-switch baseline before the epoch guards.
R01c harness remains local-only pending independent pre-live review.

R04c merged at80fc8158 after independent final-head proof and hosted general/native
checks. The integrated incremental build failed in the unchanged resync fixture;
a clean retry hit local disk exhaustion. Completed campaign build caches were
cleaned using Swift package commands, preserving source/evidence. R04d also
reproduced the fixture diagnostic after a clean Swift6.3.3 compile; hosted used
Swift6.1.2. A narrow explicit-capture alignment with the existing DaemonAPITests
fixture is approved as a separately committed R04d validation prerequisite.
Integrated R04c proof remains open until rerun succeeds.

R08b independently reviewed and fully reproduced at1e179dc1: all21 traversals
correct, independent medians2.881/28.890/625.311ms for100/1000/10000 pods. PR428
awaits hosted checks; no optimization or latency SLA claim. R01c one real native
sandbox qualification passed at44e4f39f, with independent provider GET404/cache
checks and15 local guard tests rerun at final330fc51e before PR429. Fresh initial
inventory was empty; no claim of live nonempty-inventory preservation, model
execution, full daemon lifecycle or firewall enforcement. Both PRs target only
codex/reliability. R04d applies the chosen Inline direction after its baseline.

R04c integrated proof is now complete:18 native test functions passed at43a5fad2
after the separately reviewed fixture compatibility PR430 passed hosted
Swift/Xcode checks. Earlier compile/disk failures remain recorded. R04d preserved
the duplicate POST/unconditional DELETE baseline, implemented owned controls at
7530db73 and passed42focused invocations; independent source review found no
actionable issues. Rendering and final frozen-head proof remain incomplete.

R04d independently reviewed at4e91054c:31 focused functions passed and all47
independently regenerated native PNGs matched the inspected worker captures.
Worker full suite434 Swift Testing plus13 XCTest passed; existing opt-in live
suite/test skipped. Root corrected the original no-skips evidence statement.
PR431 targets campaign; reviewed conflict resolution at30278af1 preserved the
whole packages tree and passed32 focused functions. Hosted general/Swift tests
passed; final Xcode build remains pending. Evidence is retained in r04d/.

R05b research corrected the reachable compact merge analysis and exposed discarded
decision IDs plus late-resolution/REST question replacement. Root plan at36566b48
was independently reviewed, including malformed-event scope and non-reused token
proof after pod removal/reinsertion. Worker research_desktop reuses the completed
R04c fixture checkout on codex/reliability-decision-identity; owns native identity
and event-response fencing only. Draft storage/reply binding are not implemented.
R07 navigation and server reply-admission research proceed read-only in parallel.

R04d complete at1ace904a: PR431 general/native checks passed, integrated32
functions/4 suites passed and47 native captures matched independently reviewed
images. Scope remains one handler lifetime; no reconnect outcome/draft claim.
R05b baseline at910586be reproduced three stale-decision scenarios (two test
functions, six expected issues) before its production fix. Worker implementation
continues. Reply acceptance research records post-commit HTTP failures and special
branch differences; it does not authorize an API expansion by itself.

R05b independent review passed at a8ca3f51: root reran47 affected functions/6
suites and inspected all six native question-retention captures. Full worker run
passed447 Swift Testing functions plus13 XCTest cases, with one existing opt-in
live test skipped; inaccurate zero-skip wording corrected before PR432. Hosted
checks pending. Evidence copied into campaign r05b/. R07a baseline through actual
NSApplication.sendEvent reproduced Return opening removed A after B became the
visible first row. Its approved keyboard bridge plan is implementing separately.

Main advanced to9978fb5e (existing managed-catalog PR418). Checkpoint merge
a6c0c565 had no conflicts and unique migration prefixes through209. Fresh daemon
and dependency builds passed; managed/upgrade/restore checks397passed,4skipped
(42filespassed,1skipped), shared417passed, secret scan/diffcheck passed. This
incorporates existing main work; no live Docker/provider or deployment claim.
Evidence: .autopod-data/reliability/main-checkpoint/.

R05b complete atbe22402d: PR432 hosted general/native checks and integrated47
functions/6suites passed; reviewed desktop source unchanged. Decision identity is
now available for later drafts. R06b first characterization committed72076f9f on
unchanged production:5newcases plus3cycle races passed; extraction implementing.
R07a native keyboard fix passed workerfullsuite and is entering independent review.

R07a complete at96783185: hosted general/native checks and integrated12functions
passed; all14 integrated captures matched independently inspected root images.
R06b root reproduced8 characterization/cycle cases and independent reviewers found
no findings before PR434. R04e reviewed planf8693f23 includes source-key caching,
handler ownership, late-error fencing and both explicit/automatic auth recovery
wiring; research_desktop implements in the reused completed R05b checkout.

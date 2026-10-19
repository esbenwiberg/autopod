# R06a: fence stale artifact finalization by worker cycle

## Overview and authorization

Before extracting orchestration, reproduce and repair one source-derived race:
old artifact collection must not publish or clean up a new worker cycle created
by normal Pause then Message controls within the same pod generation/container.
The user authorized autonomous RPI, workers, review and branch-contained fixes.
All phases below are authorized together; no UI/schema/protocol change.

## Current state

See research/2026-10-15-artifact-finalization-boundary.md including its follow-up.
Artifact completion coalesces by pod/generation/cycle, but its ownership predicate
only compares generation/container/status/decision/guidance. Journal mark applies
to the latest cycle. A settled worker leaves no active-run pause barrier while
its artifact copy continues. A new message after pause can create another cycle.
This is source-derived until the first phase reproduces it.

The shared ownsArtifactCompletion helper also serves non-artifact paths. In the
queued-guidance path, settle can create a journal after capture; adding a cycle
comparison globally could break that behavior. Keep those semantics unchanged.

## Desired result

A captured artifact finalization owns only its captured generation and cycle,
plus the existing container/status/decision/guidance conditions. Once a new cycle
starts, success or failure from the old artifact copy cannot publish artifacts,
mark the newer journal, fail/complete the newer run, push an artifact branch or
clean up its container. The new run remains active and can later finish normally.
Existing no-journal interactive/legacy cases, duplicate completion, preserved
snapshot retry, native no-push and cancellation behavior remain compatible.

## Scope and approach

Own bounded artifact-specific edits in packages/daemon/src/pods/pod-manager.ts
and regression cases in its existing co-located test file. Existing collectors,
receipts and journals remain unchanged unless a discovered contradiction is
reported to root. No extraction, migration, new state, provider change or broad
completion-journal redesign in this task.

Use an artifact-specific ownership check that incorporates the existing helper
and compares the current journal cycle to the captured pod's cycle, treating
absence consistently as zero for existing no-journal cases. Apply it at entry
to preservation (before marking a journal), collector isCurrent, post-copy and
error paths, snapshot reuse and finalizer checks before publication/cleanup/final
transition. Preserve the existing allowed-removed-container option. Do not
retrofit cycle checks into unrelated shared-helper callers. No stale path should
mark or transition the new cycle merely to report that it was superseded.

A cycle mismatch must remain invalid even when generation and container match.
Pass the artifact-specific assertion through cleanupContainer's existing
assertReleaseAllowed callback, which rechecks after internal awaits. Catch the
recognized superseded outcome in the artifact finalizer and return without
letting it escape into broader failure handling; preserve unrelated errors.
This does not claim atomic cancellation of an already-issued external push or
container call; it fences work at the existing await/check boundaries.

## Phase 1: reproduce via production controls

Use existing createTestContext and real SQLite ledgers with deferred infrastructure.
Establish cycle N by consumeAgentEvents receiving normal completion and settling;
do not fabricate cycle N+1 by direct DB/repository mutation. Start handleCompletion
and hold the first actual artifact extraction call at a barrier. Call pauseSession,
then sendMessage with a resumed runtime stream held open. Wait for actual resumed
consumer/admission, assert same generation/container, cycle N+1 and active durable
run, then release the old copy. Assert the intended safe result and record the
baseline failure before changing production.

The test may use existing fixture setters for initial running resources, but
cycle advancement and pause/resume admission must traverse public manager methods.
If the traced sequence is blocked by production guards, stop with evidence and
revise the plan rather than forcing the race through direct mutations.

## Phase 2: repair and characterize ownership

Prove both old-copy success and old-copy rejection after the new cycle begins:
no artifact path/source-preserved marker/terminal event/cleanup is attributed to
the new run; its journal remains running, status running and durable run active.
Capture relevant side-effect counts before releasing the old copy so fixture
setup cannot mask an added call. Preserve container/source identity.

Also hold the existing beforeContainerCleanup hook after a valid old snapshot
was published; use public Pause/Message to start the new cycle, then release the
hook. Assert no subsequent container kill or journal/status mutation, and no
escaping stale error that fails the new run. The legitimately published historical
snapshot may remain; do not mislabel its pre-supersession publication as a defect.
The new run must later complete normally in this case too.

Use actual temporary artifact directories and collector staging cleanup where
the existing fixture supports them; release and await both copy and resumed
stream in finally, dispose DB/data and restore any test-local environment override.
No arbitrary sleeps for ordering; barrier deadlines must fail and cleanup owned
work. A resumed worker that subsequently completes must still be able to publish
its own artifact and complete exactly once. Assert the old run did not suppress
this valid follow-up. Preserve duplicate-completion coalescing.

Run the pre-existing artifact manager tests, collector/receipt/sandbox-adapter
tests, pending decision/completion journal tests, pause/message regressions,
and then the full daemon suite with SKIP_DB_TESTS=0.

## Phase 3: independent proof and integration

Use explicit Node22/pnpm9.15.4 and frozen install; fresh dependent package builds.
Run supported daemon build/typecheck, scoped Biome, secret scan and git diff --check.
Record exact commands, counts, pre-fix failure and final revision. Independent
review before PR reruns the new public-path regression and examines ownership
checks plus retained behavior. PR base codex/reliability; hosted checks must pass
before integration and targeted integrated verification. No main/deploy action.

No human manual check is required for this headless contract. Evidence is real
production manager/SQLite/filesystem with controlled runtime/container adapters,
not OS-process crash, real provider or actual Docker execution.

## Acceptance

- [x] Public Pause/Message sequence advances cycle during old copy and reproduces bug.
- [x] Old copy success and failure cannot mutate/clean up the new cycle.
- [x] New worker can finish and publish its own artifact normally.
- [x] Existing artifact/interactive/no-journal/retry/pause/decision regressions pass.
- [x] Full daemon and supported validation checks pass.
- [x] Independent pre-PR review, hosted and integrated proof recorded.

## Compatibility and rollback

No migration/API change or new work. The fix rejects stale finalization authority
while preserving current run resources. Reverting the bounded guard restores
previous behavior but also restores the race. No performance optimization claim.

## Status

Prepared by root and reviewed by research_cli. Review identified an internal
cleanup-await gap; root selected the existing cleanup assertion callback and
added a public-control pre-cleanup regression, rather than narrowing the safety
claim. No other blocking findings. Worker implementation and automated proof completed
under the standing campaign authorization; independent pre-PR review is next.


## Worker evidence (R06a)

Worker branch: `codex/reliability-artifact-cycle`, based on
`526820cfbe5fd8ff3f0eff74836a761e9aa7fc41`. Runtime: Node 22.23.3,
pnpm 9.15.4, via `npx -y -p node@22 -p pnpm@9.15.4 -c '<command>'`.
Logs are local, ignored artifacts under `.autopod-data/reliability/r06a/`.

Before any production edit, the three new regression cases failed against the
base implementation (`prefix-regression.log`): old copy success and the
pre-cleanup barrier completed cycle 2 while its worker was still active; old
copy failure failed the running pod. Both cycles were admitted by the actual
event consumer; the second used public Pause and Message controls, with no
replacement journal fixture writes.

After the bounded guard, the same three cases passed (`regression.log`), including
unchanged durable journal rows and active task run after stale completion,
unchanged cleanup/publication counts, staging removal, and subsequent successful
artifact publication and exactly one completion by the resumed worker. The
pre-cleanup case retains the snapshot legitimately published before supersession.

The artifact-specific predicate leaves the shared guidance predicate unchanged.
It checks captured cycle at preservation entry, copy/reuse/error boundaries,
legacy publication awaits and finalization. The existing cleanup callback checks
again after internal awaits; its recognized stale error returns locally while
unrelated cleanup errors keep their existing propagation behavior.

Reproduce the focused proof from the repository root:

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c 'SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t "fences old artifact finalization"'
```

No external pods, provider calls, Docker execution or UI changes are involved.
The proof uses production manager/collector code, real SQLite/filesystem and
controlled runtime/container adapters. It does not claim cancellation of an
already-issued external side effect. Test-owned streams/barriers are released
and awaited; SQLite is closed, temporary artifact trees removed and DATA_DIR
restored in teardown. Independent pre-PR review and hosted/integrated proof
remain coordinator-owned and are not checked off by this implementation.


Validation commands executed inside the wrapper above:

- `pnpm install --frozen-lockfile && pnpm --filter @autopod/daemon... build`
  passed before the regression run, including native SQLite installation.
- `pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts`
  passed.
- `SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts`
  passed: 7 files, 703 tests (`targeted.log`). This includes existing interactive,
  no-journal, duplicate completion, snapshot retry, decision and pause cases.
- `pnpm --filter @autopod/daemon build && pnpm --filter @autopod/daemon typecheck && pnpm secret-scan`
  passed on the final source (`build-typecheck-secrets.log`). Typecheck means the
  repository-supported tsup declaration check, not an additional raw whole-tree
  TypeScript check.
- `git diff --check` passed.

- `SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon test` passed: 388 files passed,
  5 skipped; 6,091 tests passed, 10 skipped (`full-daemon.log`, 95.59 seconds).
  DB inclusion was forced; the pre-existing gated suites remain skipped.

Worker verdict: **PROVEN** for the bounded stale-cycle behavior and local
compatibility contract. All three tests failed before the production change and
passed after it; the full daemon suite passed on the same final source. The
independent review/integration acceptance item remains open. The immutable
committed revision and source hashes are recorded in the worker handoff and
local `proof.json` to avoid a self-referential commit identifier in this plan.

## Final integration proof

PROVEN for the bounded stale-cycle contract at worker
f1b8fc9ee0a3aabfbf1c319b8859a60501bcbf26. Independent reviewer read the
production/test diff and ownership context, reran3 public-control regressions
and703 affected tests, and found no actionable issue before PR423. Coordinator
also reviewed the final diff and proof. Hosted CI38788118870 and
Desktop38788119020 passed. PR423 merged at5cc8fbc6; eight affected suites704tests
passed on integration, including the real process-death recovery proof. Evidence
is retained in .autopod-data/reliability/r06a/ and r06a-integrated.log. Controlled
runtime/container and non-atomic external-operation limitations above still apply.

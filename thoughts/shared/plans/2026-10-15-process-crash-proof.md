# R01b: prove retained decisions across process death

## Overview and authorization

Add a genuine child-process crash/reopen test around production persistence and
local reconciliation. This is a bounded verification prerequisite for lifecycle
restructuring. The user authorized autonomous RPI, worker branches and independent
review/proof, and explicitly instructed the campaign to proceed. All phases here
are authorized together. There is no UI change or human acceptance item.

## Current State Analysis

Research is recorded in `thoughts/shared/research/2026-10-15-reliability-verification-seams.md`.
Current source at campaign base `980e0b86` has independent production constructors
for SQLite (`db/connection.ts`), migrations (`db/migrate.ts`), pod/journal
repositories (`pods/pod-repository.ts`) and injected local reconciliation
(`pods/local-reconciler.ts`). Completion tests reopen real databases after a clean
close; they do not establish persistence through an OS-process kill.

`reconcileLocalSessions` retains unanswered decisions before inspecting container
state or worktrees. It records a restart diagnostic and skips the pod without
enqueueing replacement work. SQLite uses WAL with synchronous NORMAL. This task
proves process-crash behavior only, not host-power-loss durability.

Root esbuild is available. A fixture can be bundled as ESM with packages external,
placed under the daemon's ignored `.turbo/` directory for native package resolution.
The child uses the parent's Node 22 executable, matching installed SQLite bindings.
It must not import Vitest's in-memory mock-helpers into plain Node.

## Desired End State

After actual SIGKILL with the database connection still open, a fresh process
reopens the same disk file, reconstructs production repositories and reconciles.
It preserves the unanswered decision, completion report, lifecycle generation,
source/worktree/container identities and produces no replacement work or cleanup.
The second reconciliation pass remains idempotent. Integrity and foreign keys pass.

## Scope and implementation

Own a co-located test `packages/daemon/src/pods/local-reconciler.process.test.ts`
and a plain-Node fixture `packages/daemon/src/test-utils/local-reconciler-process-fixture.ts`.
Add a small process helper under test-utils only if it clarifies ownership.
Update this plan with exact evidence. Do not change production modules, migrations,
dependencies, daemon bootstrap, provider configuration or container resources.

### Phase 1: explicit process and fixture ownership

The Vitest parent creates a unique temporary data directory and an ignored unique
bundle directory under packages/daemon/.turbo. Build the fixture from current TS
sources with esbuild (ESM, Node22, packages external). Pass absolute DB/migration
paths as argv. Fork with process.execPath, controlled child home/temp/cwd and no
inherited auth/provider/proxy/NODE_OPTIONS settings. Use a private child home/temp
tree and validate that the child resolves them there.

Register IPC, error and close listeners immediately. Bound IPC/output sizes and
barrier/termination waits. Watchdog termination is failure. Kill only owned children;
await close/reaping before deleting data/bundles. Parent finally handles partial
setup, early child error and failed assertions. No arbitrary sleeps for ordering.
On Windows, explicitly skip the POSIX signal-specific test with the reason; macOS
and Linux must execute. SKIP_DB_TESTS=0 is mandatory for recorded acceptance.

### Phase 2: pending decision survives crash and reconciliation

Seed an empty disk DB through production createDatabase/runMigrations. Use an
explicit synthetic pod configuration accepted by the production repository, plus
an unanswered escalation row and matching pendingEscalation. Use real temporary
worktree paths and fixed synthetic container/source identities. Establish final
awaiting_input through valid production status transitions where possible; fixture
SQL is allowed for synthetic legacy/escalation setup, not production mutations.
Call the actual completion journal settle/mark awaiting_human methods.
Require the journal to exist; do not optional-chain calls. Do not seed an active
task_agent_runs row or deletion cleanup claim: either would bypass the intended
pending-decision path through the separate unresolved-ownership guard.

Send a typed IPC `ready` snapshot only after all synchronous durable operations
return, with the connection still open. Keep the child alive on IPC; do not close
the DB or voluntarily exit. Parent validates the snapshot and sends SIGKILL, then
asserts observed close has null exit code and SIGKILL signal.
The ready barrier explicitly records db.open=true and db.inTransaction=false.

Start a fresh child on the same disk file. Construct production pod and validation
repositories. Supply explicit recording event/container/enqueue/cleanup boundaries
to reconcileLocalSessions; unexpected calls must be reported and fail assertions,
not silently succeed. Run reconciliation twice. Report before/after durable
snapshots, both results, recorded side effects, PRAGMA integrity_check and
foreign_key_check. Close the DB normally in this second child before reporting
completion/exit.

Assert:

- Distinct writer/recovery process identities and observed SIGKILL of writer.
- Before/after decision identity and question, null response, settled report,
  completion phase, generation, branch, worktree and container identities match.
- Status remains awaiting_input and no invented response appears.
- Both passes report skipped only; no enqueue, container operation, event emission
  or cleanup request occurs. lastRecoveryTrigger is restart and lastCorrectionMessage
  is exactly: `Human decision remains pending after daemon restart. Review the pending question; preserved worker state may require recovery before continuation.`
- Duplicate settle/finish cannot erase the unanswered decision or report, following
  established journal behavior, and the original records remain unchanged.
- Integrity is ok, foreign_key_check is empty, and normal reader close is zero.
- Owned children are reaped and temporary data/bundle paths removed on completion.

No real provider/container is involved. Recording adapters establish absence of
calls at that boundary; they do not prove Docker behavior.
Compare an explicit durable snapshot containing the full journal, pending decision,
escalation response, generation and source/resource identities; exclude updatedAt,
lastRecoveryTrigger and lastCorrectionMessage because reconciliation updates them.

### Phase 3: proof and review

Use Node22/pnpm9.15.4, frozen install and fresh shared build. Execute:

1. `SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/local-reconciler.process.test.ts src/pods/local-reconciler.test.ts src/pods/completion-journal.test.ts`.
2. Relevant daemon typecheck/build and Biome checks on changed TS; secret scan and
   git diff --check. Full daemon tests before PR if no unrelated environment block.
3. Independent reviewer runs the process test against the final commit, checks the
   OS signal/IPC evidence, isolation and cleanup, and inspects the diff before PR.
4. Open PR only after review, targeting codex/reliability, observe hosted checks,
   integrate and verify the affected boundary on the integration branch.

All pnpm commands use npx as documented; use the explicit Node22 wrapper to avoid
the host Node24/native-ABI mismatch.

## Acceptance checklist

- [ ] Real writer SIGKILL and fresh reader process observed.
- [ ] Production disk SQLite/migrations/repositories/reconciler exercised.
- [ ] Pending decision/report/source/resource identities retained.
- [ ] Reconciliation twice produces no duplicate work or cleanup.
- [ ] Database integrity and foreign-key checks pass.
- [ ] Owned process/filesystem teardown verified.
- [ ] Relevant regression/build/type/lint/secret checks passed.
- [ ] Independent final review and hosted PR checks recorded.

## Performance, migration and rollback

No migration or product behavior change. Bundle once per suite, reuse only its
immutable code, use fresh data per test. Reverting test/helper files removes this
coverage without changing production. Failures are evidence to investigate, not
permission to weaken assertions or substitute graceful close for SIGKILL.

## Status

Prepared by coordinator from source and delegated research. Independent technical
plan review by research_lifecycle found no architecture blockers; its three guard
clarifications and explicit open/uncommitted barrier checks are incorporated above.
Ready for implementation under standing authorization and the user's Go.

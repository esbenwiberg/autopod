# Checkpoint 3 — actual-base checks and task accounting

This is a partial implementation checkpoint. All six workstreams remain open and the goal is not complete. No production mutation, paid canary, push, PR, merge or external message occurred.

## Implemented and locally proved

- Strict worktree creation/fetch now precedes contract create/update/delete checks against the remote base SHA, including when starting from a linked PR branch. Existing create targets and absent update/delete targets require stale-contract reconciliation before provisioning. Delete facts require an actual deletion diff, verified absence, and a passing command; unavailable presence is not a pass.
- Migration 143 assigns durable logical-task membership and distinct pod execution identities. Linked fixes retain the root task; independent reruns receive separate identities. Agent run receipts survive close/reopen, retain original binding and immutable settlement, reject stale generations, and do not reconstruct unknown historical runs. Membership changes require a distinct execution.
- The actual event-consumption path checks cumulative task tokens before opening the provider stream. Parent agent tokens and harness phases count once. Corrected provider-attempt totals take precedence over duplicated legacy pod totals; discrepancies and unavailable measurements remain explicit. This is measured token enforcement, not an assurance about unreported in-flight spend.
- Bounded task projection avoids deserializing unrelated prompt/validation JSON. API, CLI status, mobile detail and desktop cost card expose task, pod, run, provider-attempt and validation units separately. Recorded cost is explicitly partial and missing infrastructure billing is null, not zero.
- Backup receipt version 2 inventories every actual SQLite table, correcting the prior hardcoded validation/escalation table names. Version 1 remains verifiable as a legacy subset. Full-schema isolated restore retained the backed-up task run while leaving a newer active run untouched.

## Evidence and limits

- Desired-behavior regressions failed before fixes: task ledger (4), linked-fix budget path (1), stale-contract manager path (1), backup table scope (1). Earlier failed fixture/tool invocations remain in receipts and are not pass evidence.
- `checkpoint-3-affected.txt`: 582 tests passed across actual manager lifecycle, task ledger, completion journal, real Git base checks, validation engine and backups.
- `task-api-migrations.txt`: 86 tests passed, including malformed-record bounded API projection and upgrades from schemas 139, 141 and 142. Separate corrected-telemetry suite: 9 passed. Backup full-schema suite: 7 passed.
- CLI status command tests, mobile refresh/disconnection component test, workspace build (7 tasks), configured daemon declaration typecheck and mobile typecheck passed. Desktop Swift suite: 330 tests passed; native desktop interaction is still unverified.
- Built mobile local browser interaction verified task totals, refresh, 390x844 readability and explicit unavailable state after local fixture disconnection. This is not a physical-phone or live-daemon acceptance result.
- Lint passed over 797 files after formatting the fixture. The additional direct whole-project daemon `tsc --noEmit` failed with 1,556 output lines; its baseline and scope are not yet reconciled. The configured declaration-only task passing is not proof that all source types pass.
- Source tested here is based on 51c2fa3f with this checkpoint's modifications. Exact final committed revision validation remains outstanding. The prior full required pipeline is still red on dependency audit; no audit failures have been suppressed.
- Local/remote-tracking migration scan checked 262 refs and found no prefix >=143 before creating migration 143. Live origin/main was reverified as 2d5456edac542a99d27f12eb1dbd16e5ad8c2c2a. Original staged README and three untracked entries remain unchanged.

## Next unfinished work

1. Persist relevant failure-input identities and authorized retry overrides, bounded transient backoff, and task-wide retry/extension limits.
2. Implement exact-input deterministic validation reuse and the fixed-coverage seeded-defect benchmark.
3. Wire deterministic scheduled collection, durable triage and human repair selection into scheduler/operator flows.
4. Finish durable idempotent delivery receipts and comprehensive outcome/history reconciliation.
5. Complete per-execution environment provenance, actual production history/cost diagnosis, remaining preflight capabilities and equivalent-work detection.
6. Reconcile direct TypeScript errors and dependency audit, run the full required pipeline on exact final source, complete supported UI interaction proof and prepare the bounded release/rollback/canary approval packet.

Read-only Azure VM Run Command session 29869 still has not returned. It is not deployment, root-cause or backup proof; no second Run Command was started while it remains pending.

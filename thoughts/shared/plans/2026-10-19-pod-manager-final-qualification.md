# Slice 34: final ownership and regression qualification

Status: IN PROGRESS. Authorized phase group: research → plan → audit/implement → qualify,
under the remaining-roadmap execution authority. Baseline: edd4fa089c6cad8407fb853fa0d389d9c129a581;
product implementation: 0501aa6826dc80d0a42e74a866f233cd3de76e8b.

## Overview and current state

Finish the finite rewrite by proving every original inventory unit has an owner and
qualifying the final frozen tree. Slice33 already reduced the manager to 1,421lines,
with73 runtime entries, max10line public bodies,109unchanged construction statements,
and narrowed domain ports. This does not itself establish all327original owners or
cleanup for26original mutable bindings. Complete research and routing evidence live in
../research/2026-10-19-pod-manager-final-qualification.md and
.autopod-data/final-qualification/. Original source is local commit
ecc324ca4a403d49397dd63cecb1a881e653ad06, not a reconstruction.

## Desired end state and approach

Every original row has a justified current owner, full-body/type/initializer provenance
or explicit split/composition proof, and reachable construction/consumer wiring. Resolve
all multiple candidates explicitly. Preserve retained composition, captured versus live
ports, defaults, receiver timing, error/promise identity and historical limitations.
Every original mutable binding has one creating owner and concrete executed assertions
for its actual release/replacement/stop contract. Finish architecture, public regression,
real SQLite/local recovery checks and a frozen full uncached pipeline, then reconcile
hashes at a clean pushed revision. An evidence gap remains open until resolved.

## Phase 1 — complete inventory and ownership audit

Changes: create a repeatable audit and row-by-row report in
.autopod-data/final-qualification/, and a concise versioned verification report under
thoughts/shared/verification/. Audit all327roadmap units against baseline AST and final
source. Direct token/type-erased matches are319routing leads; combine them with actual
owner construction/exports/call wiring and earlier whole-source extraction recipes.
For rows73/193 prove captured destructuring/startup composition. For258/262/275/276
prove exhaustive stage partitions from baseline through qualified extraction recipes,
not just their public delegates. For279/282 prove original-reference shorthand identity.
Recheck33architecture verifier on final source, all73entries,72declared protocols,
manager<=1500/public bodies<=10, no residual algorithms or broad domain manager imports.

Automated criteria:
- [ ] Exactly327unique rows reconcile without an unresolved or arbitrary owner.
- [ ] All8special rows have explicit complete provenance; all73public entries reconcile.
- [ ] Architecture and original-reference/default/protocol checks pass on final bytes.

Human verification: no new manual acceptance is required for this local audit. Existing
visual plans remain reference material; do not assert new visual/live acceptance.

## Phase 2 — mutable state and cleanup contracts

Inspect all26bindings and their actual owner/consumers plus underlying primitives.
Record exact test names/assertions and run the relevant suites. Account for caller-owned
injected state and ephemeral locals separately. Test semantics must reflect actual
original contracts: polling stop clears registrations/intervals without aborting remote
work, watchdog stop does not drain dispatched work, host retry releases on replacement/
fire, deletion keeps its25sdeadline/late-operation limits, coalescing remains in-process.
Add focused missing lifecycle assertions only where needed, without altering policy,
fixtures, thresholds, skips or implementation merely to obtain green results.

Automated criteria:
- [ ] All26bindings have creating owner, consumers and executed cleanup/stop evidence.
- [ ] Relevant owner, race, recovery, public and SQLite/reopen suites pass on final tree.
- [ ] Any new assertions have scoped semantic checks; inherited diagnostics remain explicit.

Human verification: none newly required. Product/persistence/credential policy changes
would require a separate decision and are outside this audit.

## Phase 3 — frozen final qualification and handoff

Freeze package/script sources and six root controls after any necessary assertion work.
Use a dedicated final-qualification runner with the already qualified pinned
Node22.23.3/pnpm9.15.4/SQLite3.49.2 and task-local inherited lint input allowance.
Run ./scripts/validate.sh with TURBO_FORCE=true and SKIP_DB_TESTS=0; retain commands,
logs/exits, frozen install status, uncached groups, test identities and unchanged skips.
Recheck hashes, public assertion bytes, architecture and all ownership reports afterwards.
Commit/push authorized checkpoints and final report; no merge/deploy/PR is included.

Automated criteria:
- [ ] Frozen install, lint/build/DTS/typecheck/tests/audit/secret scan pass, no new skips.
- [ ] Original1192public assertions unchanged; real SQLite and relevant recovery evidence pass.
- [ ] Final source/test/root hashes match, architecture and327/73/26reports pass.
- [ ] Clean pushed revision recorded; roadmap and this plan accurately completed.
- [ ] Only after all required evidence passes, mark the active goal complete.

Human verification: live Docker/Azure/paid provider execution and integration/deployment
are separately authorized work, not final acceptance gates or claims for this branch.

## Testing, compatibility and migration

Use existing co-located suites and repository-native commands. No dependency, schema,
API, default, persisted snapshot, credential or side-effect policy change is intended.
No migrations. Rollback remains ordinary Git revert of separately reviewable commits.
Retain native fix alias, stale memory reviewer protocol and historical72/73interface
limits exactly as qualified. Timeouts and stopped remote work retain original bounds.
No performance claim is introduced by documentation and verification work.

## References

- ../plans/2026-10-18-pod-manager-remaining-roadmap.md (finish line and standing authority)
- ../research/2026-10-19-pod-manager-final-qualification.md (complete research)
- ../plans/2026-10-19-pod-manager-facade-composition.md (Slice33qualification)
- .autopod-data/facade-composition/proof.json and /tmp/verify-slice33-movement.cjs

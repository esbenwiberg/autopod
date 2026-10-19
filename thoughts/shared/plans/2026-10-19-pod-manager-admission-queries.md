# Slice32: complete admission, queries and series ownership

Status: IMPLEMENTED — frozen expanded/full qualification in progress.
Date:2026-10-19. Baseline:3d1ed855c49357e2b4fac2ef6bfec3d44ba03739.
Qualified implementation:33a5fc9c1d945a95e9b213df5499f07138a3d78f.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-admission-queries.md.

## Outcome and approval

Move all27complete function/method bodies assigned32, preserving native/legacy
admission, source/configuration snapshots, publication/queue effects, memory context,
dependent-series/restart and query/credential behavior. Same73public members/import
paths. Manager begins3,096lines. This is the third-last delivery milestone;33must
finish<=1,500line facade/composition,34must qualify all327inventory units/73members/
mutable owners. The goal remains ACTIVE through34, not complete at32.

The standing goal explicitly groups the remaining research→plan→implement→qualify
sequence and commit/push checkpoints, with concrete plans before source edits. That
approval supplies phase/structure/implementation authority without repeating per-slice
questions. This plan follows the established characterize→extract→qualify structure.
No unresolved product choices. Allsource/test bytes at31and six root hashes match.

## Current facts and chosen ownership

Research inventories27bodies and four dynamic receiver paths. Live dependency fields
are launchConfiguration/githubAuth/azureDevOpsAuth/memoryRepo. Preserve those reads
on original dependency object; narrow interfaces describe only each owner's observed
fields. Capture original services/callbacks, not a public manager/broad dependency bag.
No domain module imports PodManager/PodManagerDependencies/ContainerManagerFactory.

All new files under packages/daemon/src/pods/, each<1,000lines:

1. admission-policy.ts: complete warnIfSinglePrSeriesMissingSeriesMeta/mergeOverrides;
   manager imports them at former call sites. No persistent map/state.
2. admission-memory-briefing.ts: complete podMemoryScopeIds/approvedMemoriesForPod/
   selectMemoryBriefingForPod; preserve public export from manager by re-export.
   Preserve inherited unresolved default reviewer factory/client protocol diagnostics;
   do not repair ranking or invent live provider acceptance in a compatibility rewrite.
3. admission-execution-context.ts: effect-free createAdmissionExecutionContext owns
   executionForPod/executionCredentialsFor/injectionsForPod/resolveGitCredential.
   Construct at original executionForPod site, after captured services exist and before
   first original consumer. Same frozen fail-closed/profile fallback, scoped-secret
   refusal, exact github.com validation, daemon injection isolation and live adapters.
4. admission-dependents.ts: complete maybeTriggerDependents/rehydrateDependentSessions.
   Construct immediately after createCompletionGuards, before any earlier consumer;
   only captures already-destructured repository/events/logger/queue. Preserve separate
   ordinary/restart waitForMerge predicates, cascade marker healing/event ordering,
   fan-in/shared/single/stacked base selection, frozen base, timestamps and enqueue.
5. admission-resolved.ts: complete createResolvedSession with captured existing domain
   admission/capability helper and narrow live launch/Goal ports. Existing
   admitComposablePod remains unchanged. Same account/capability/sidecar/network/Goal
   gates, dependency callback and initialize timing. Compose before public return.
6. admission-legacy.ts: complete384-line createSession. Same410gate/human rerun/replay,
   PAT/provider preflight, branch/options/skip/warm-image/sidecar/trust/overlap policy,
   ten-try UNIQUE predicate, every insertion field, afterInsertCommitted publication
   and root-only enqueue. No native/legacy unification. Compose before public return.
7. admission-analysis-workspaces.ts: complete history/memory workspace helpers with
   narrow this.createSession and live memoryRepo. Same encoded query/task/content/
   creator and workspace options. Native410behavior remains. Compose before return.
8. admission-memory-context.ts: complete getProjectMemoryScope/getLaunchMemoryContext.
   Same live frozen scope and captured reviewer executor/profile,20s prompt closure,
   stdout result and unavailable error. Compose after createReviewerContext.
9. admission-queries.ts: complete getLaunchConfiguration/getSession/deployment/singular
   and plural MCP/listSessions/stats/series/validationHistory. Same repository data,
   optional repo fallback, native running-only checks, before/after capability fences,
   scoped vending and post-await this.getInjectedMcpServers fallback. Compose before
   public return; capture original execution helpers and optional validationRepo.
10. admission-series-deletion.ts: complete deleteSeriesWithCascade with narrow this
    kill/delete methods, sequential awaits and original catch/log/continue policy.
    Nonempty requirement and final log retained; no promise of all-resource deletion.
11. admission-contracts.ts: explicit captured/live/receiver/query/context types using
    existing domain types. Type-only references to domain factories are acceptable;
    no type dependency on public manager. Only method parameters/returns that formerly
    received contextual typing gain equivalent explicit annotations; parameter names,
    order, optional/default behavior and every body token remain exact. Original
    typed parameter syntax remains intact. Compiler assignability checks establish
    equivalent public-to-owner argument/result protocols rather than assuming any.

All public32methods become thin delegates, using .call(this,...) for the four original
receiver paths; preserve dynamic property lookup inside deferred callbacks. Void
rehydration invokes without returning a value. Other return/async behavior retains
original signature/timing. Constructors invoke no domain callback, enqueue/timer/
repository/service effect. Existing startup delivery call remains at same relative
site/arguments, and all original mutable state creation/order/reference identity stays.
Existing source owners, tests/helpers and allother2,168predecessor package/script files
plus six root controls stay fixed; product changes only manager plus11newsource files.

## Phase1: provenance and whole source recipes

Save verified31full proof/public provenance, before-manager,27complete bodies/defaults,
captured/live/receiver inventory and frozen predecessor/root hashes. Save full file
recipes for manager+eleven owners/contracts. Annotation equivalence is checked with
actual TS types; no body/default/await/error/creation-data policy change permitted.

Automated:
- [x] All2,169predecessor package/script hashes/six roots and public bytes match.
- [x] All27whole bodies/parameters/context annotations/references/recipes are captured.
Manual:none for bounded local compatibility, under standing grouped approval.

## Phase2: complete implementation and boundary evidence

Implement all owners and coherent composition. Add focused co-located suites for
policy, memory briefing, execution context, dependents, resolved/legacy admission,
analysis workspaces, memory context, queries and series deletion. Test helper in
test-utils/admission-queries-helpers.ts reuses actual existing repositories/configuration
fixtures and controlled adapters. Keep all predecessor assertions/helper bytes fixed.

Tests prove native/legacy refusal and admission, after-commit event/queue ordering,
transaction rollback/no publication, rerun actor/replay/uniqueness, frozen snapshot
after preset edits, account/sidecar/network/capability gates and create metadata.
Dependents cover fan-in/missing parent/cascade heal/shared branch/single/stacked/
frozen base, and explicitly assert original restart waitForMerge difference. Series
deletion exercises failure continuation and receiver replacement across awaits.
Queries cover filters/identity/optional fallback, live capability replacement around
vending, refused running/secret access and post-await dynamic MCP fallback. Memory
tests cover approved scope isolation, fallback selection/usage, encoded workspaces,
unavailable context, exact prompt/timeout/stdout and captured reviewer executor.

At least four actual private-file SQLite close/reopen boundaries cover admitted legacy
metadata, immutable native snapshots, dependent/restart effects and rollback/rerun
receipts. Verify integrity/FK and relevant unrelated profile/config rows. Existing
configuration series/admission/ledger suites run unchanged; mock-only effects do not
claim real paid/provider/container/Git/deletion acceptance. Settle controlled deferred
work and actual post-insert setImmediate publication before closing fixtures.

Build daemon/deps/DTS; scoped Biome/whitespace; zero new test/helper semantic diagnostics;
compare changed-source diagnostics against full original manager baseline, keeping
known stale reviewer protocol and other inherited diagnostics explicit. Run all
unchanged1,192public cases and new direct suites with actual immediate collaborators
and inherited72workspace/resource/operator/fix/delivery/approval suites. AST audit all
27bodies/defaults, context-only annotation equivalence, all12fullrecipes,73members/
thin delegates/four receivers, effect-free constructors/construction/startup sequence.

Automated:
- [x] Complete movement/default/context-type/full recipes/construction audit passes.
- [x] All73public members and receiver/live/captured contracts preserved.
- [x] Unchanged1,192public assertions/names/statuses and direct behavior tests pass.
- [x] At least four actual SQLite reopen/rollback/frozen-admission boundaries pass.
- [x] Build/lint/whitespace/semantic comparison pass, zero new-test diagnostics.
Manual:none for bounded local extraction; live acceptance/integration separate scope.

## Phase3: frozen qualification and next responsibility

Expand all272inherited affected suites with new and missing admission/query/memory/
series/configuration/transaction/receipt collaborators; save deduplicated unfiltered
selection and SKIP_DB_TESTS=0command. Freeze source/test/root hashes, commit/push the
implementation and run exact repository pipeline:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable local npx launcher, frozen install
without fallback and uncached Turbo. Only inherited root-lint2MiBprocessing allowance/
82warnings. No rule/config/dependency/selection relaxation, no new skips. Record actual
delta from31's9,002Vitest/587passing files/35Node cases/same ten inherited gates.
Retain failures/logs/reports honestly before reruns; never alter runtime assertions.
Apply prove-work to frozen final implementation, full recipe and behavioral claims;
save proof.json/commands/exits/hash/revision/limits under .autopod-data/admission-queries.
Research33while32source stays frozen. Only after proof update plan/roadmap32complete,
commit/push docs and verify clean remote identity. Then two milestones33–34remain.

Automated:
- [ ] Expanded SQLite-enabled regression passes without new skip.
- [ ] Full frozen uncached pipeline passes; counts/versions/skip/hash evidence saved.
- [ ] Proof, clean pushed implementation/docs and source hashes verified.
- [ ] Plan/roadmap32completion and complete33research saved.
Manual:none; PR/main/deployment/live provider/container acceptance separately authorized.

## Compatibility, limits and rollback

No migration/profile/state/API/persistence/security/product-policy correction, new
retry/deduplication or stronger atomicity/replay/termination guarantee. Existing
post-commit scheduling, native alias limitation, stale reviewer protocol and distinct
dependent/restart policies persist. Same import paths through re-exports. Revert
manager and eleven source owners/contracts together. No unresolved choices remain.
Full goal remains ACTIVE until34's actual architectural/regression finish gates pass.

## Implementation checkpoint — 2026-10-19

All27whole bodies/defaults/runtime parameters and all12full source recipes match.
Seven contextually typed methods gained equivalent explicit annotations, including
optional flags that were supplied by public contextual typing. Actual same-program
public/owner parameter and result assignability passes both ways for allsixteen
declared public protocols. deleteSeriesWithCascade remains the original seventeenth
object entry outside the historical PodManager interface; the existing supplemental
excess-property diagnostic is preserved, not fixed as a product/API change. Same73
members/order/seventeen thin delegates/four dynamic receivers. Original constructor/
startup statements are token-identical in order; all new factories only capture and
define functions. All2,168other predecessor package/script files and six roots match.
Manager3,096→2,247lines; eleven newsource files25–420lines. No replacement monolith.

Public1,192names/statuses/assertion bytes pass. Final91-suite direct selection passes
680cases:38new across ten suites,573inherited direct cases and69additional existing
admission/memory/configuration/series collaborator cases. Six actual private-file
SQLite reopen boundaries exercise legacy metadata, committed publication/rollback,
frozen native configuration after preset edits, rolled-back native admission,
dependent healing/frozen base and authenticated rerun receipt/replay. Actual event
bus/ledgers/snapshot resolver/unit-of-work execute; discovery/provider/container/auth
effects remain controlled. Integrity/FK and relevant unrelated rows are checked.
Late MCP/series receiver replacement, live capability recheck around secret vending,
memory scope/fallback/usage and exact prompt/timeout contracts pass.

All11newtest/fixture files have zero semantic diagnostics. All18changed-source
supplemental diagnostics match the original18manager diagnostics, including known
stale memory reviewer protocol/public-interface limitations. Original scoped build/
declarations passes; full frozen rebuild remains required. Scoped lint/whitespace
pass without disabling rules. First fixture failures were schema-only credential/
rerun types, untyped empty mock list, profile update stripping preflightConflictPolicy
(now actual SQL setup like existing public test) and task identity belonging to the
actual execution ledger rather than Pod. Assertions remain; raw first extended direct
report retained in direct-first.json, alongside distinct early/corrected reports/logs.
Initial duplicate-import/unused scaffolding and contextual optional AST audit handling
were corrected without body changes. No unrelated product policy repair.

Allsource/test bytes frozen at2191package/script files plus six root controls.
Expanded/full qualification/proof,33research and clean pushed docs remain before32
is complete. Goal stays ACTIVE through34.

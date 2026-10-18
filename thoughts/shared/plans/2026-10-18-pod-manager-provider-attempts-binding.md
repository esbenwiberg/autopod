# Slice 21: provider attempts and binding

Status: IN PROGRESS — extraction and affected regression complete; full qualification next.
Date: 2026-10-18. Baseline: 939f19a2deaa855f181f2a464d95ae30bf265224.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-18-pod-manager-provider-attempts-binding.md.

## Objective and authority

Continue the full “rest of the slices” goal. Finish the provider-attempt/binding
ownership defined by milestone 21, then continue through 22–34. Preserve the existing
characterize → extract → qualify checkpoints without repetitive per-slice approval,
as recorded in the current remaining roadmap. No API, behavior, schema, credential
policy, paid provider dispatch, PR/main integration or deployment changes.

## Current state and chosen boundary

The manager has 14,371 lines. Nineteen synchronous functions, one failover-selection
type and the MAX credential-lineage collection belong to this milestone. Attempt
repository and launch reads are live original deps lookups; account/catalog/profile
store and execution profile resolver are captured manager references.

Create two internal modules:
- provider-attempt-policy.ts: complete redactedProfileSnapshot,
  profileReferenceForAttempt, nativeSessionId, reasoningEffortFromSnapshot and
  resolvedReasoningEffort functions. These have no manager-local collaborators.
- provider-attempt-context.ts: createProviderAttemptContext returns the complete
  providerForAttempt, ensureProviderAttempt, rotateProviderAttemptForFreshSegment,
  closeProviderAttempt, isCompatibleTarget, selectProviderFailoverTarget,
  escapeProviderTargetDiagnosticValue, describeProviderFailoverTarget,
  providerFailoverUnavailableActivity, profileForProviderTarget,
  resolveEffectiveBoundProfile, openProviderTargetAttempt,
  rememberMaxCredentialLineage and forgetMaxCredentialLineage functions plus the
  original maxCredentialLineageByPod map. Keep ProviderFailoverSelection local here.

Only existing product change is pod-manager.ts: imports, composition, original
function/type/map removal and strictly unused import cleanup. Existing callers and
algorithm bodies stay unchanged. New tests: provider-attempt-policy.test.ts and
provider-attempt-context.test.ts. No public test edits are planned: the complete
1,192-case manager suite already covers public failover, binding, initialization,
stale ownership, seeded legacy/rework attempts and snapshot reasoning.

Both new owners stay under 1,000 lines. No intermediate size exception is needed.

## Dependency and initialization contract

createProviderAttemptContext(live, captured) receives the ORIGINAL deps object through
this narrow live view (keep existing variable name deps inside original bodies):

    providerAttemptRepo?: Pick<ProviderAttemptRepository,
      'getActive' | 'getActiveProfileSnapshot' | 'list' | 'open' | 'close'>;
    launchConfiguration?: { read(podId: string): EffectiveLaunchConfig | null };

Capture exactly six existing references once:

    podRepo: Pick<PodRepository, 'getOrThrow'>;
    providerAccountStore?: ProviderAccountStore;
    providerCatalog?: PublicProviderCatalog;
    profileStore: Pick<ProfileStore, 'resolveProviderFailover'>;
    executionForPod(pod: Pod): PodExecutionSettings;
    activeAgentRuns: Pick<Map<string, {
      token: symbol; providerOrdinal?: number; isCurrent?: () => boolean;
    }>, 'get'>;

The account store's full infrastructure type is required by the existing auth/launch
helpers; no new public-manager dependency type is imported. Keep original receivers,
late optional service/method reads and references. The active-run getter returns the
same owner object, so providerOrdinal updates keep their original meaning.

Move the exact Map constructor into the context factory and return it unchanged.
Construction performs no repository/account/profile calls. Compose the context right
after activeAgentRunResolvers construction, after activeAgentRuns exists, before
merge-poller startup and worker/reviewer context composition. The pure reasoning
function remains a static policy import for the EARLIER runtime-resume factory;
there is no early read of a later factory binding. The old lineage map has no actual
constructor-time argument consumer before worker/reviewer composition. Preserve this
ordering and verify all symbol references before/after extraction.

## Behavior to preserve

- Provider snapshot/account/profile/runtime fallback precedence and caught account
  lookup failure. Redaction nulls sensitive subtrees, handles arrays recursively,
  strips URL userinfo/query/fragment, preserves ordinary text, never mutates input.
  Hash reference format/length and native-session/reasoning selection stay unchanged.
- Active profile snapshot/reference remains authoritative. requireNew rejects active
  attempts; mismatch rejects; legacy nonzero usage becomes a completed segment before
  the fresh segment opens. Preserve account nullability and repository call order.
- Rotation keeps run token/current/ordinal fences, no-repository/no-active/no-prior
  noops and unstarted handoff continuation exemption. Close aborted before opening
  replacement; update the same owner object's ordinal only when its token still agrees.
- Close retains expected ordinal, native session, observed usage, classification and
  handoff. Do not alter accounting, transaction policy or stale-error propagation.
- Failover respects configured order, history, maxHops, runtime/account/catalog
  eligibility and exact typed diagnostics. Deleted or unauthenticated candidates
  remain ineligible. Diagnostic escaping/bounds remain unchanged.
- Immutable launch accounts/routes, queued binding snapshots and active/latest
  attempts retain their existing authority over mutable defaults. Auth helpers and
  credential protocols remain unchanged; target open retains reasoning/redaction.
- MAX lineage map retains per-manager identity, exact lineage value references and
  remember/delete semantics shared by worker credentials and reviewer context.

## Phase 1: characterize the exact baseline

Verify all 1,991 package/script hashes and six root controls still equal Slice 20's
qualified manifest, plus the exact unchanged public test file. Reuse Slice 20's full
1,192-case post-extraction manager result as the unchanged-source before evidence;
record its provenance and hash equality explicitly instead of rerunning equivalent
baseline checks. Freeze all public assertions and full names/statuses. No new skips.

Automated:
- [x] Qualified predecessor source/test hashes and 1,192-case baseline evidence match.
- [x] Original definitions, initialization points and all existing caller references saved.
Manual: none; remaining sequence is authorized together.

## Phase 2: extract and prove contracts

Move all nineteen bodies/parameter lists and the local selection type intact; only
add factory/export/dependency scaffolding, imports/composition and the original map
constructor relocation. Check the entire explicit manager/module recipe and every
original caller/reference with parsed TypeScript, normalizing formatting only.
All manager implementation outside that recipe and all public assertions remain intact.

Direct policy tests cover sensitive/nested keys and URL shapes, preservation/reference
format, native session ids and exact reasoning precedence, including invalid snapshot
values. Direct context tests cover the identity/ordinal/account/target/diagnostic/
lineage/live dependency contracts above. Use actual migrated pod/attempt/account/
profile repositories, local synthetic credentials and real auth/launch-route helpers
where asserted. At least three private file SQLite cases verify attempt history,
redacted snapshots/usage, retained account/profile state and stale rejection through
integrity/FK-checked close/reopen. Exercise current immutable launch and account
identity denial using real resolver/snapshot fixtures where practical. Runtime/Goal/
provider execution stays controlled; no paid or live provider calls.

Run the unchanged full manager suite, both new direct suites, supplemental semantic
checks for both new test files, scoped Biome/whitespace and daemon/dependency build.
Preserve failures and fix extraction/fixture faults without changing old assertions
or original algorithm policy. Freeze final source before broader qualification.

Automated:
- [x] All nineteen bodies/parameters, selection type, map constructor and complete
  recipe/call references match the original behavior.
- [x] Full manager names/statuses/assertions remain unchanged and pass.
- [x] Direct policy/context/local repository cases pass with no new skips.
- [x] Build/declarations, scoped lint/whitespace and new-test semantics pass.
Manual: none.

## Phase 3: qualification and continuation

Run all inherited 97 affected suites plus the TWO new paths, unfiltered (99 total):

    src/pods/provider-attempt-policy.test.ts
    src/pods/provider-attempt-context.test.ts

Resolve/deduplicate the exact command from
.autopod-data/validation-workflows/affected-command.json. Then run on frozen source:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use the established npx launcher, Node22.23.3/pnpm9.15.4/SQLite3.49.2. Frozen install
must pass without fallback or lock mutation. Retain the 2 MiB root lint processing
limit only and process-only maintenance.auto=false. No rules/selection/config/deps
changes. Compare complete package/script and root-control hashes after qualification.
Record actual counts, inherited skips, failures and limits; commit/push checkpoints
and verify clean remote identity. Complete this plan and update roadmap, then start
Slice 22. The goal remains the entire remaining sequence through final Slice 34.

Automated:
- [ ] All 99 affected suites pass with SQLite and no newly skipped tests.
- [ ] Full uncached pipeline passes; actual results and existing skips recorded.
- [ ] Source scope, frozen hashes and clean pushed revision verified.
- [ ] Plan/roadmap record this milestone and next incomplete work.
Manual: none.

## Compatibility and rollback

No migration or public contract change. Keep sync/async boundaries and credential/
account/ordinal authority unchanged. No performance or stronger authorization,
atomicity, isolation, replay or live-execution guarantee. Revert manager composition
and both new modules together to roll back. Evidence stays ignored under
.autopod-data/provider-attempt-context/. The existing validation-trigger size debt
still belongs to Slice 27; this milestone does not redefine that requirement.

## Phase 2 evidence

All nineteen original bodies and parameter lists, selection type and map initializer
match parsed TypeScript. Complete explicit manager/module recipes match after
formatting-only normalization. All 1,990 other baseline package/script paths, public
assertions and six root controls remain byte-identical. The manager has 13,833 lines
(538 fewer); new policy/context modules have 91/552 lines. Six captured references
and original live deps retain the planned initialization order and service receivers.

All 1,192 unchanged public manager cases pass with identical names/statuses. All 44
direct policy/context cases pass, including three encrypted private file SQLite
close/reopen cases for legacy usage, target snapshots and stale ordinal rejection.
Actual migrated pod/attempt/account/profile repositories, auth/launch helpers and a
real resolved immutable launch snapshot are exercised with synthetic credentials.
The 99 affected suites pass 3,450 cases without skips. Build/declarations, scoped
Biome, whitespace and both new-test semantic boundaries pass.

Initial generated import duplicates/missing type were corrected in scaffolding only.
Direct fixture diagnostics identified a duplicate policy account, invalid Pi auth
shape and the account-store guard against deleting referenced accounts. Fixtures now
use distinct accounts, a valid Pi credential and a controlled historical lookup
failure; queued-account deletion remains exercised through the real store. No old
assertion or algorithm body changed. A standalone runtime probe needed the daemon's
actual dependency path; its corrected result is Node22.23.3/SQLite3.49.2. Source-audit
type fragments are parsed in a type wrapper. Initial logs/reports remain retained.

Final 1,995 package/script hashes and six root controls are frozen before the full
uncached pipeline. Next: qualify, record completion, then continue Slice 22 under the
existing remaining-slices goal. No manual gate is outstanding for this milestone.

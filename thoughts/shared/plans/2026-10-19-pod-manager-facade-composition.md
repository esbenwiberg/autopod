# Slice33: stable facade, dependency contracts and final composition

Status: COMPLETE — frozen implementation qualified and pushed.
Date:2026-10-19. Baseline:1dfca753f34bb93bc879ec7ad9a95f6940198590.
Qualified implementation:2bbc454a42f826dcf2683948297f0ac26cdafd6c.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-facade-composition.md.

## Outcome and authority

Finish33's actual architecture gates:manager<=1,500total lines, composition and thin
delegates/projections with no domain algorithms; all73public entries preserved with
bodies<=10lines; stable public contract import paths; no domain file depending on
PodManager/PodManagerDependencies or the broad public manager bag. Keep all109current
construction/startup statements and owned map/timer/semaphore identity/order unchanged.
34still owns final327baseline-unit/73member/mutable-owner reconciliation and frozen
integration-ready qualification. Goal remains ACTIVE through34.

The standing goal groups remaining research→plan→implement→qualify and commit/push
checkpoints. This concrete plan precedes source edits and resolves all design choices;
no repeated approval is required. Current2,191package/script hashes and six roots match
qualified32; previous goal turn made progress by implementing and qualifying32.

## Concrete implementation

All new paths under packages/daemon/src/pods/, each<1,000lines. Only three predecessor
source files change:pod-manager.ts,pod-bridge-impl.ts,memory-candidate-recorder.ts.

1. pod-manager-contracts.ts moves exact ContainerManagerFactory,
   PodManagerDependencies and PodManager declarations with only required type imports.
   Re-export unchanged names from pod-manager.ts; existing index.ts export path stays.
   Do not add the historical omitted deleteSeriesWithCascade interface method or change
   optional/signature/credential/result policy. Public input stays a composition-only
   contract; no domain workflow imports it. All member protocols are AST/type checked.
2. pod-manager-facade.ts owns only the current73member public object. Its factory takes
   a PodFacadeOwners interface of explicitly observed owner methods/callbacks and
   returns the original object. It imports no public manager/dependency type. Preserve
   every async declaration, parameter name/default, order, shorthand function identity,
   promise behavior, .call(this) and lazy receiver lookup. Contextually typed parameters
   gain equivalent explicit annotations; missing return annotations may be made explicit
   using existing domain result types/ReturnType of exact owner functions to prevent
   circular inference. Public manager return type remains unchanged at the composition
   entry. Do not make this domain facade a second orchestration algorithm/module.
3. pod-facade-ports.ts names the facade's composition ports. For each owner object use
   Pick<ReturnType<typeof domainFactory>, observed public method keys>; for callbacks
   use the original domain factory output function. Repository access is only
   Pick<PodRepository,'getOrThrow'> and execution/environment helper signatures. No broad
   manager/public dependency alias, no new copied service/state object. The facade
   captures original instances/functions once at the same return site. No domain owner
   receives this aggregate facade assembly port.
4. pod-facade-calls.ts moves exactly the triggerValidation proxy object's five lazy
   arrows to createValidationTriggerCalls(receiver:ValidationWorkflowCalls), using the
   existing narrow domain receiver protocol. Replace only lexical this with receiver
   inside those same five arrows. Construct at the original public method call, not at
   manager construction. Original .call(proxy,podId,options) stays; the public delegate
   becomes<=10lines. Every proxy method still resolves the current receiver property
   when invoked, preserving method receiver, arguments, returned value/error/promise.
5. pod-bridge-ports.ts defines SessionBridgeManagerPort with exactly the ten manager
   members actually read by bridge. Copy their original public signatures/optionality
   without importing PodManager; use existing domain/shared types. Define exact structural
   SessionBridgeContainerFactory get(target):ContainerManager. pod-bridge-impl.ts changes
   only type imports and its two dependency property annotations; full runtime body and
   all initializers remain token-identical. Keep runtime object named podManager so
   existing captured receiver semantics remain unchanged.
6. memory-candidate-recorder.ts changes only optional launchContext type to
   (pod:Pod)=>AdmissionLaunchMemoryContext, importing Pod/shared and domain context type.
   Existing native scope/reviewer/serialized inference/listener/sets/cleanup code and
   every runtime initializer remain token-identical. Actual type assignability both ways
   proves same callback protocol. Existing recorder mutable state remains its own.
7. pod-manager.ts imports stable contracts/facade, re-exports public types and replaces
   original final object literal with createPodManagerFacade of exact original owner
   references. All109construction/startup statements stay unchanged/in order. Move only
   type declarations/delegation object out; prune unused imports. Retain module-level
   execFileAsync=promisify(execFile) as an explicit composition adapter at its original
   creation lifetime, supplying existing provisioning domain code. This is a justified
   retained33composition entry, not a residual domain algorithm. No cosmetic packing or
   threshold increase to reach1,500. Actual formatted line count must pass.

Public facade inference may remove the old excess-property diagnostic because the
same extra runtime series method is now returned through a factory. That does not add
it to the public interface or fix product policy. Preserve all original contracts and
runtime members; record any such diagnostic relocation/removal honestly. Other inherited
source diagnostics remain scoped baseline evidence, not an excuse for new type errors.

## Phase1: immutable baseline and complete recipes

Save exact manager/contracts/73methods/109statements, trigger proxy AST, two domain
consumer files and matching32source/public provenance. Capture every facade free
identifier with original declaration/factory/type and observed owner property names.
Save full source recipes for allthree changed plus five new files. Allowed transforms
are imports/exports/type-only contract extraction and annotation, facade assembly,
the documented lexical trigger receiver substitution and type-only consumer narrowing.
No original workflow body/default/await/error/event/publication/credential policy changes.

Automated:
- [x] Qualified32hashes/public provenance and complete original captures match.
- [x] Full recipes, public types/73members,109construction statements and ports captured.
Manual:none under grouped local compatibility approval.

## Phase2: implementation and architecture/behavior proof

Implement allfiles coherently. AST audit exact three public interfaces; all73method
names/order/async/default/body tokens except documented trigger proxy relocation;
actual contextual argument/result protocols equivalent; original109construction and
startup statements/exec adapter initializer unchanged; facade assembly pure; full eight
source recipes match. Both narrowed consumer runtime bodies/initializers remain exact.
Verify actual public exports and module dependency graph, no new runtime cycle.

Gate manager<=1,500formatted total lines, all public body ranges<=10, each new file<1,000.
Manager contains only imports/exports, the primitive exec adapter and composition;
facade contains only delegates and existing small validation-environment projection.
No loops/retry/timer/resource/approval algorithms. Scan allpods domain sources for
public PodManager/PodManagerDependencies/broad-bag imports; only public contracts,
composition entry and index re-export may name the public interfaces. Facade and
allinternal ports themselves do not import public manager types. No broad alias dodge.

Add focused pod-manager-facade.test.ts,pod-facade-calls.test.ts and
pod-bridge-ports.test.ts with shared fixture only if necessary. Use actual manager
construction with controlled infrastructure; observe original owner references at
facade boundary without adding production hooks. Prove no extra constructor effects,
per-manager state separation, shorthand identity, original synchronous throws/async
promise behavior and default/argument propagation, deferred current receiver/method
replacement across allfive trigger callbacks and original narrow bridge heartbeat/
native configuration/memory/revalidation boundaries. Existing public1,192cases and
all91inherited direct suites plus actual bridge/recorder/environment/trigger owners
run unchanged. Do not add tests that only mirror every delegate line.

At least two actual private SQLite reopen cases through the final composed public
facade cover created legacy metadata/after-commit queue publication and actual frozen
native admission/configuration despite later preset edits. Reuse real native fixtures/
ledgers/snapshot services, not copied admission logic. Verify integrity/FK/unrelated
rows and no post-rollback publication. Existing recovery/ownership suites retain
their six+prior actual database boundaries. Controlled adapters do not imply live
paid/provider/container/cloud acceptance. No new timers/listeners/cleanup guarantees.

Run daemon/dependency build/DTS, scoped Biome/whitespace, zero new test/fixture semantic
diagnostics, baseline comparison for allchanged source. For expected diagnostics that
disappear solely from context/public facade extraction, record origin and cause, never
weaken rules. Full unchanged1,192public names/status/assertion bytes and direct cases
must pass final source; original assertions/helpers remain byte fixed.

Automated:
- [x] Exact contracts/73methods/trigger proxy/full recipes/construction/consumer runtime audit.
- [x] <=1,500manager/<=10public bodies/<1,000newfiles/no broad domain imports/no cycles.
- [x] Public1,192and direct boundary suites pass, including two actual SQLite reopens.
- [x] Build/DTS/lint/whitespace/types pass without new source/test diagnostics.
Manual:none for bounded extraction; real external acceptance/integration separate.

## Phase3: frozen qualification and final audit preparation

Expand all304inherited affected suites with new facade/ports/public import/bridge/memory
recorder/configuration/dependency consumers, preserving deduplicated unfiltered selection
and SQLite enabled. Freeze final source/test/root hashes, commit/push implementation.
Run exact final pipeline on those frozen bytes:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Observe Node22.23.3/pnpm9.15.4/SQLite3.49.2; frozen install without fallback, uncached
Turbo. Only inherited root-lint2MiBinput allowance/82warnings; no rule/config/dependency/
selection relaxation. Record actual delta from32's9,040Vitest/597files/35Node tests,
same ten inherited gates and no new skip. Retain raw first failures/reports before
reruns; no runtime threshold adjustment. Apply prove-work to final facade/architecture/
compatibility claims and save .autopod-data/facade-composition/proof.json plus hashes/
commands/results/versions/limits. Research34complete inventory/mutable-owner audit
while33source stays frozen. Only then mark33complete, commit/push docs and verify clean
remote identity. One milestone34remains, and full goal remains ACTIVE.

Automated:
- [x] Expanded SQLite-enabled regression with no new skip passes.
- [x] Full frozen uncached pipeline/versions/counts/skips/hash evidence pass.
- [x] Proven architecture/behavior and clean pushed revision verified.
- [x] Plan/roadmap33complete and34current-state audit research saved.
Manual:none; no PR/main integration/deployment or unexecuted live acceptance claim.

## Compatibility and rollback

No migration/profile/state/API or credential-policy correction, new effects, retry,
replay/termination/atomicity guarantee. Same public imports, exact contract shape,
73runtime entries, original instance lifetimes and receiver/default/error timing.
No dependency changes. Revert manager/facade/contracts/ports/calls and two type-only
domain consumer changes together. Existing alias/reviewer/interface limits remain.
34must prove every original finish gate;33does not declare the whole goal complete.

## Implementation checkpoint — 2026-10-19

Allthree public contracts are token-exact in stable module and original import paths
remain. Same73runtime entries/order/async/default/parameters,72declared public facade
protocols assignable both ways and original shorthand identities. All109construction/
startup statements and exec adapter initializer/lifetime match. Facade captures43
original owner/callback references through observed-method domain ports; no domain
owner receives the aggregate facade port. Both bridge/recorder files emit identical
runtime code after type erasure; ten exact bridge protocols and memory callback are
equivalent. Original five trigger lazy arrows match with only lexical this→receiver
and are created at the original public call. Full eight source recipes match.

Manager2,247→1,421lines, max public body10lines; five new source files12–500lines.
No residual condition/loop/retry/timer/resource algorithms in manager/facade and no
domain public manager/dependency-bag references. Only public entry/contracts/index
name the public types. New runtime edges are manager→facade→call adapter, without a
new cycle. Every2,188other predecessor package/script file and six root controls match.

Unchanged1,192public names/statuses/assertion bytes pass. Final99-suite direct run
passes822cases:13new across three suites,680inherited direct cases and
129additional existing bridge/recorder/environment cases. Two actual private-file
SQLite reopens through the final public facade cover legacy metadata/committed queue
publication and canonical frozen native configuration after preset edits, with actual
repository/snapshot/ledger, integrity/FK and relevant unrelated data. Deferred
property replacement/receiver/promise/error/default behavior, per-manager watchdog
interval separation/stop and same shorthand function identities are directly tested.
Original inherited direct/recovery/persistence suites also run unchanged.

Allthree new test files have zero semantics. Full supplemental audit of allthree
original source files has15baseline diagnostics; changed source now has10, all inherited.
Removed diagnostics are unused imports and the historical object-literal series excess
property warning avoided by factory-return inference; the original public interface
still omits that runtime entry. Unchanged admission memory reviewer diagnostics remain
outside this slice. No product/API correction or rule relaxation. Final build/DTS,
scoped lint and whitespace pass.

First scaffold issues were optional/default type syntax, void annotation lint and
unused imports; explicit actual domain ReturnType annotations retain original bodies.
Verifier treats defaults/proxies as expressions and accounts for redundant default
type annotations removed by Biome. Test-only widened mock result and partial Task
service object types were corrected without assertion changes. Named original logs/
exits and direct-early.json are retained; first runtime direct run already passed13.
No inherited assertion or runtime threshold changed.

Allsource/test bytes frozen at2,199package/script files plus six root controls.
Expanded/full qualification, final proof,34audit research and clean pushed docs remain
before33is complete. Goal stays ACTIVE through all34finish gates.

## Final qualification — 2026-10-19

PROVEN. Frozen implementation0501aa6826dc80d0a42e74a866f233cd3de76e8b is pushed.
Manager1,421lines; max public body10lines; no residual algorithm/broad domain manager
type dependency/new runtime cycle. Allthree public contracts,73runtime members/
72declared public protocols,109construction/startup statements,43actual facade
references, original exec adapter and eight full source recipes pass. Both consumer
runtime outputs are unchanged after type erasure; ten bridge methods and memory
context callback remain equivalent. Public import paths/default/async/receiver and
five lazy trigger arrows retain their original behavior.

Full frozen uncached pipeline:9,053Vitest pass/600passing files plus35Node cases,
same ten inherited full gates/no new skip. Expanded308suites:5,471pass/four identical
inherited gates. Direct99suites:822pass, including13new cases/three suites and two
actual private SQLite reopens through final public facade. All2,199package/script
hashes and six roots match. Build/DTS/typecheck, lint, tests, audit and secrets pass.

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Observed Node22.23.3/pnpm9.15.4/SQLite3.49.2; frozen install without fallback and all
Turbo7/11/15groups uncached. Only82inherited root-lint warnings and existing task-local
2MiBprocessing allowance; no rule/config/dependency/selection relaxation. Supplemental
changed-source audit has10diagnostics, all inherited from15diagnostics across allthree
original sources; three new test files have zero diagnostics. Removed unused imports
and factory-return excess-property diagnostic are documented without API/policy fix.

| Claim | Evidence | Result |
|---|---|---|
| Final facade size/ports/contracts/receiver/construction gates |Exact AST/type/erased-runtime/recipe audit;1,192unchanged public cases | PROVEN |
| Public API persistence and owned state/default/error/promise behavior |822direct cases/two actual SQLite reopens;308affected suites; full frozen pipeline | PROVEN within controlled external adapters |

Evidence:.autopod-data/facade-composition/proof.json,movement.json,
public-comparison.json,frozen-manifest.json,semantic reports,exact commands/logs/exits.
Initial type-only scaffolding/test typing/verifier expression corrections are retained.
First new runtime direct run13cases passed; first expanded/full frozen runs pass.
No predecessor assertion/runtime threshold changed.

Limits:controlled local infrastructure/provider/discovery/credential/reviewer adapters;
no paid/live providers, Docker/Azure/cloud acceptance, remote deletion/messages,
PR/main integration or deployment. Original lifecycle/timeout/replay/termination and
native fix alias/stale reviewer/interface limitations persist.34still must reconcile
all327units/73public entries/26mutable-state ownership leads and execute its own final
frozen qualification/clean pushed revision audit. Current319token routing matches and
eight special entries are research leads, not completed owner/cleanup proof.

Complete34research saved:../research/2026-10-19-pod-manager-final-qualification.md.
One milestone34remains. Goal stays ACTIVE until every final finish gate is proven.

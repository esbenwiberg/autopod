# R06b: extract artifact finalization with observable compatibility

## Scope and authority

Move the existing artifact-output responsibility out of pod-manager into a bounded
module after characterizing its public behavior. User authorized autonomous RPI,
subagents, technical phase progression, independent review, task PRs and campaign
integration. Root owns this plan based on artifact-finalization-boundary research
including its R06a follow-up. No visible UI, new feature, API/schema or deployment.
All phases are one technical task under standing authority after plan review.

## Current boundary and intended result

The manager currently nests preserveArtifacts and finalizeArtifactPod plus the
artifact-only cycle predicate/assertion. They share snapshot preservation with
interactive completion. The automatic path also performs optional legacy branch
publication, source cleanup and completion. Dependencies and exact order are
recorded in the research. Extract these functions into artifact-finalizer.ts with
a typed factory; manager keeps lifecycle admission, coalescing and shared policy.
The result must preserve behavior, errors, activity strings and durable ordering.
The new module can be exercised through narrow supplied collaborators without
constructing the entire manager; existing manager tests still prove real wiring.

## Phase 1: characterize before moving production code

Own new cases in packages/daemon/src/pods/pod-manager.test.ts. Use its existing
real SQLite repository/event journal plus controlled infrastructure and private
temporary DATA_DIR/worktree directories. Run and commit the added characterization
against unchanged production first; it should pass. This is a behavior-neutral
refactor, so do not manufacture a failing baseline. Preserve exact logs/revision.

Add meaningful public handleCompletion cases for legacy artifact publication:
- Successful preservation copies actual report bytes into a real temporary
  worktree; assert create branch/base fallback, commit message/deletion bound and
  push destination. Exercise explicit branch/base and existing fallback variants.
  The test file globally mocks child_process: explicitly forward only the expected
  cp with owned private source/destination paths to real execFile (vi.importActual),
  await its callback/child settlement, and restore the mock. Unrelated commands
  stay mocked. File-content assertions must observe the production copy.
- Rejected legacy push remains best effort: snapshot and receipt remain valid,
  cleanup occurs and completion follows; no source-loss or thrown-failure claim.
- At the existing beforeContainerCleanup seam and actual kill recorder, observe
  stored artifactsPath, valid snapshot content and sourcePreservedAt, running
  lifecycle and no complete event. After release, complete/finished and exactly
  one terminal transition follow. A bounded barrier prevents timeout acceptance.

Also pin a rejected automatic finalizer's registry release: an injected existing
execution-settings failure (controlled existing profileStore.get after initial
fixture creation) rejects joined callers without copying/cleanup; restoring the
resolver permits a fresh public completion to succeed. Preserve current rejection
semantics rather than switching this to the preservation-failed path. Use actual
public admission/coalescing and observable effect counts, not private map access
or Promise-object identity. Start both calls before awaiting and assert exactly
one throwing resolver invocation after fixture setup; otherwise two independent
rejections could falsely satisfy the test. This uses executionForPod outside the preservation
catch; no new production failure hook is required.

All tests release and join owned work in finally, bound barriers, close DB, restore
DATA_DIR and remove only their private paths. Do not mock snapshot/receipt logic
or child-process copy merely to assert a repeated call sequence. Existing R06a
cycle, interactive/no-journal, duplicate, corruption and retry tests remain intact.

## Phase 2: extract the existing responsibility

Own packages/daemon/src/pods/artifact-finalizer.ts and bounded pod-manager.ts
wiring/import changes. Factory createArtifactFinalizer returns preserveArtifacts
and finalizeArtifactPod. Move only those functions and the artifact-only predicate/
assertion; retain their captured Pod authority and every await/check boundary.

Use existing domain types and narrowly typed collaborators: repository get/update/
optional completionJournal, container selection, shared ownsArtifactCompletion,
execution settings, handover, Git credential resolution, required worktree methods,
cleanup, transition, logger and activity emitters. Use Pick where useful; no any,
new service locator or dependency on pod-manager at runtime. Avoid moving shared
interface definitions solely for this extraction; a typed container-selection
callback can adapt the existing factory. No configurable plugin architecture.

Shared ownsArtifactCompletion stays manager-owned with queued-guidance semantics.
So do artifactCompletionRuns/artifactResumeRuns, all public admission/observation/
resume paths, approval and interactive orchestration, cleanupContainer, transition
and all decision/guidance policy. Pass the artifact assertion through existing
cleanup exactly as before; do not replace transition with raw repository writes.

Keep real existing collector/verifier, mkdir and cp behavior. DATA_DIR stays read
at invocation, never factory/module creation. Retained verification stays outside
the collection catch. Preserve optional-journal/cycle-zero behavior, all messages,
legacy repoUrl/launchConfigDigest condition, branch/base/message fallbacks, catch
scopes, source publication order, native no-push, error logging and swallowed
versus propagated errors. Do not add cancellation, timers, retries, cleanup policy,
new transactions or fix unrelated defects inside the movement.

Factory construction must finish before public operations can use it; no changed
eager side effects or environment capture. Remove imports only if no other manager
caller uses them. The diff should make movement independently recognizable.

## Phase 3: prove compatibility and independent integration

Rerun identical characterization and existing R06a three public-control races
after extraction. Compare asserted observable outcomes before/after, not just
line counts. Add a focused factory-boundary test only for a material new seam
that public tests cannot cover; do not mirror implementation with mocks.

Node22/pnpm9.15.4 commands from repository root:

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm --filter @autopod/daemon... build'
npx -y -p node@22 -p pnpm@9.15.4 -c 'SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts'
npx -y -p node@22 -p pnpm@9.15.4 -c 'SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon test'
npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm --filter @autopod/daemon typecheck && pnpm secret-scan'
```

Run scoped Biome on changed TypeScript and git diff --check. Record actual
versions/counts/skips/exits and source/evidence hashes. Freeze final source.
Independent pre-PR reviewer checks movement, dependency ownership/catch order,
reruns characterization plus cycle regressions and verifies evidence. Only then
PR into codex/reliability; hosted checks and integrated affected tests precede
closure. Existing gated live suites are skipped, not passing real-pod proof.

## Acceptance and limits

- [x] Added public characterization passes on unchanged source with recorded SHA.
- [ ] Typed artifact boundary extracted without behavior or ownership changes.
- [ ] Identical characterization and interruption races pass after movement.
- [ ] Full daemon and supported build/typecheck/hygiene checks recorded.
- [ ] Independent pre-PR, hosted and integrated checks complete.

No human manual judgment is required for this headless compatibility contract.
Evidence uses real SQLite/filesystem with controlled runtime/container/Git adapters;
it does not establish OS-process death, real cloud execution or cancellation of
already-issued operations. No migration or rollout; reverting module/wiring restores
the same behavior. Known coverage gaps outside selected cases remain explicit.

Independent plan review found no blocker. Root incorporated explicit real-cp
forwarding beneath the existing global child-process mock and a single resolver
invocation assertion for rejected coalescing. All phases are approved under the
standing campaign authority; no unresolved product or technical choice remains.

## Implementation evidence: Phase 1

Production baseline d6a724df79af365764cac54b88e4fc6fb796ea65 remained unchanged.
Five added public-manager cases plus the three existing cycle races passed:
8 passed, 666 deselected/skipped by the name filter, one file. Node22.23.3,
pnpm9.15.4, Vitest4.1.11; frozen install passed. Exact focused command:

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c 'SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t "artifact finalizer compatibility|fences old artifact finalization"'
```

Private logs: .autopod-data/reliability/r06b/characterization-before.log and
install.log. Earlier fixture-only failures are retained in characterization-
fixture-adjustment.log (existing synthetic Git credential) and characterization-
branch-fixture.log (branch not writable through PodUpdates).

Expected: characterize explicit branch and branch/base fallback variants.
Found: public creation binds branch; SQLite branch is NOT NULL and PodUpdates
cannot change it. Adjustment approved by coordinator: exercise explicit branch
through createSession and ordinary generated research/<id>, plus nullable
base/profile fallbacks. Preserve defensive null-branch fallback verbatim but do
not claim runtime coverage of its unreachable SQLite arm. No fake nullable
repository view or production behavior change was introduced.

The real cp subprocess is allowed only for exact private snapshot/worktree paths,
with a 3-second timeout; tests await callback settlement and restore the mock.
Hook and kill observations both verify receipt/content and durable publication
before completion. The five cases close their SQLite DBs and use existing private
completion DATA_DIR teardown. No provider request or real Git push occurs.

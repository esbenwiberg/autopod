# Artifact finalization ownership boundary

Date: 2026-10-15. Source baseline: campaign 74a5b2cf (pod-manager unchanged).
Research by research_lifecycle; coordinator rechecked ownership predicate,
preservation/finalization bodies and completion admission against live source.
No product edits or tests were performed for this research.

## Existing responsibility map

In packages/daemon/src/pods/pod-manager.ts:

- ownsArtifactCompletion (7098) checks lifecycle generation, container identity,
  running status, no pending escalation and no queued guidance. It does not
  compare the finalization cycle.
- preserveArtifacts (7196) verifies an existing receipt-backed snapshot or marks
  preserving, collects a snapshot, stores artifactsPath and marks source preserved.
  It uses DATA_DIR/filesystem operations and the injected container factory.
- finalizeArtifactPod (7250) performs handover sync, preservation, optional legacy
  repository publication, container cleanup and complete transition. Native
  artifact delivery with launchConfigDigest does not publish an artifact branch.
- handleCompletion (12194) performs native-goal/status/pending-decision/guidance
  admission. Its artifact branch coalesces promises by podId:generation:cycle.
- Interactive completion calls the same preservation function at14404.
- resumePod artifact path (18180) coalesces by pod ID, verifies any retained
  snapshot, checks captured lifecycle/container and failed status, transitions
  running and calls handleCompletion. collect-artifacts returns after complete.
- Resume observation (18156) consults the two in-memory run maps.

Durable authority includes pod fields, pod_finalizations (migration164 keys
pod/generation/cycle), emitted events and filesystem snapshots. Promise maps are
not durable authority. Completion journal mark checks generation and retains
unanswered decisions. Transition also updates journal phase/events and failure
readiness. Shared cleanup has preview, memory, PIM and credential-lineage effects.

The collector timeout cannot cancel adapter extraction. Its staging cleanup waits
for actual late copy settlement (artifact-preservation.ts:29-75). Ownership checks
therefore matter after awaits as well as on admission.

## Existing tests and limits

Manager tests at18970-19243 cover interactive success/failure, cancellation during
extraction, native no-push behavior, duplicate completion, failed-copy retry
without another worker, corrupt snapshot rejection and retained-snapshot resume.
Collector tests cover retained snapshots, stale ownership, late timeout settlement,
exclusions and missing source. Receipt tests cover content/path/mode/link/inventory
tampering, wrong generation/cycle/root and missing/bounded inventory failures.
Local reconciliation tests retain interrupted artifact collection without enqueue
or container kill. A sandbox adapter test exercises real filesystem/receipts and
Fastify retrieval with a controlled client, not full scheduling or a real provider.

Inspected artifact restart coverage recreates a manager over the same in-memory
SQLite DB. No located case kills a process between receipt publication, database
publication, container removal and final status. No located artifact case changes
cycle within a generation during extraction. Cancellation coverage does not cover
every handover, legacy-publication and cleanup await. R01b pending-decision crash
proof does not establish these artifact-specific properties.

Available command, not run in this research:

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c 'SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t "artifact|artifacts"'
```

This is a descriptive boundary map. A subsequent plan must select exact
characterization and extraction scope before code moves; this research is not
an implementation authorization or a claim that missing-cycle comparison is
reachable as a production defect.

## Follow-up: same-generation cycle reachability

Source tracing found an ordinary non-Goal public-control sequence, still
unexecuted at research time:

1. consumeAgentEvents settles the journal, ends the durable run/admission and
   clears activeAgentRuns; processPod then calls handleCompletion.
2. Artifact extraction waits while pod status remains running.
3. pauseSession (13975) suspends the runtime and waits only for activeAgentRuns;
   the prior worker already settled, so pause completes without joining the copy.
4. sendMessage (12961-13032) accepts paused, transitions running and resumes the
   same container. It does not consult artifact promise maps.
5. consumeAgentEvents calls journal.begin (11629), creating cycle N+1 in the same
   generation. Journal begin checks unanswered decisions/generation, not a
   preserving phase.
6. Old extraction can pass ownsArtifactCompletion, which compares no cycle.
   Journal mark selects the latest cycle, so old publication may mark the new
   cycle and proceed to container cleanup and complete.

The sequence needs healthy continuation preflight/budget and a non-Goal pod.
Message while running or pause-settling is rejected; a retained worker queues
input; native Goal gates prevent this path. Artifact resumePod retries collection
without a new cycle; fresh-provision rework increments generation.

Root rechecked pause, normal message continuation, worker admission, journal
begin/mark and preservation against source. A public-method deferred-copy test
is needed before calling this a reproduced defect. The shared ownership helper
also serves uncollected-guidance paths, where settle may create a journal after
the Pod snapshot was captured. Artifact cycle checks therefore must not be
blindly imposed on those unrelated uses.

## Follow-up: extraction boundary after R06a (2026-10-15)

Source ddd3c492c9e410ecf26afb7c417b8738e6a3a32e, incorporating main9978fb5e.
Agent research_lifecycle traced current callers/dependencies; root reread ownership,
preservation/finalization, collector, cleanup, transition, interactive/coalescing
paths and artifact manager test block. No new tests or product changes in this
research; the earlier R06a704-test result remains historical evidence.

R06a now adds artifact-specific cycle equality at pod-manager.ts7115–7130.
Preservation at7213–7266 is54lines plus16artifact guard lines; automatic
finalization7268–7332 makes120function lines total. Preservation uses repository/
journal, container selection, shared ownership, status/error emitters and logger.
The larger boundary additionally uses handover, execution settings, Git credentials,
worktree operations, cleanup and lifecycle transition, plus filesystem/copy.

Shared ownsArtifactCompletion7098–7112 also serves workspace failure and queued
guidance; it is not artifact-only. Completion/resume maps4006–4007 remain owned
by admission, observation and retry code. Automatic callers12300–12312 coalesce
by pod/generation/cycle, defer execution until registration, and delete only the
identical promise. Observable coalescing is shared work, not public Promise identity.
Interactive completeSession14437 calls preservation only; its source-retention
and failure behavior differs from automatic completion. Approval has a separate
snapshot path and is not part of this artifact-output boundary.

Preservation resolves DATA_DIR at invocation. Retained snapshot verification occurs
before the collection try/catch and rechecks captured ownership. New collection
marks preserving, emits Collecting artifacts…, publishes filesystem/receipt, then
updates artifactsPath and marks sourcePreservedAt. These are ordered operations,
not a transaction. Failures log and set reason/nonfatal activity only while owner,
then rethrow. CompletionJournal.mark targets the latest cycle, so the captured
cycle fence remains material. No-journal compatibility uses cycle zero.

Automatic completion checks ownership, awaits handover, checks again and resolves
settings before its preservation catch. Handover/settings failures may reject.
Preservation failures transition failed only while owner. Legacy publication runs
only for repoUrl without launchConfigDigest. It fences after mkdir, credential,
worktree creation, copy and commit; push errors warn and are swallowed. Cleanup
uses the existing shared assertion callback across internal awaits; only the
recognized stale-artifact error is swallowed there. Final ownership allows the
removed container, then calls the existing transition carrying journal finishing,
readiness/memory and events. Already-issued external operations are not cancelled.

Existing tests19035–19220 establish three public Pause/Message cycle races;
19222–19430 cover native no-push, duplicate automatic completion, snapshot reuse/
corruption, retry, and automatic versus interactive failure. Interactive duplicate
completion18565–18604 also exists. Collector/receipt/adapter tests cover actual
filesystem work with controlled infrastructure. Manager recreation is not process
death and adapter simulation is not a cloud resource.

No explicit legacy artifact publication success/failure contract or complete
snapshot-publication→cleanup→terminal ordering assertion was located in that
block. Duplicate success is covered; registry release after rejected finalization
and ownership change during retained verification are additional unqualified
scenarios. This describes coverage; it is not evidence of new defects.

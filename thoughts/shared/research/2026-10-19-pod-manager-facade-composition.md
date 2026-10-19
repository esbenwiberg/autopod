---
date: 2026-10-19T10:54:46+02:00
researcher: Codex
git_commit: 2bbc454a42f826dcf2683948297f0ac26cdafd6c
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice33 stable facade, dependency contracts and remaining composition"
tags: [research, codebase, pod-manager, facade, composition]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice33 research: remaining facade and composition

## Research question and baseline

Describe the manager's remaining declarations, construction sequence, public delegates,
type consumers and broad domain dependencies after32's complete admission extraction.
Source is 2bbc454a42f826dcf2683948297f0ac26cdafd6c, committed/pushed. Manager2,247lines/73public members;
all32source/test bytes are frozen while expanded/full qualification remains pending.
This research neither marks32complete nor changes33product source.

Current full source and exact AST inventory are saved in .autopod-data/facade-composition/
before-manager.ts and research-inventory.json. The inventory records every non-import
top declaration, all109factory-body construction statements and all73public entries,
including full text/line ranges and each method body statement/line count.

## Public contracts and exports

All following references use packages/daemon/src/pods/pod-manager.ts. Import/re-export
area is:1–243. execFileAsync(:245) is the remaining module-level runtime binding,
promisify(execFile), captured by existing provisioning composition. ContainerManagerFactory
(:247–249) is get(target:ExecutionTarget):ContainerManager. PodManagerDependencies
(:251–376) is the public composition input: captured infrastructure plus live optional
launch/account/credential/retry/repository services. PodManager(:380–656) is the existing
public service interface, including optional configuration/query/native Goal entries.
These exact protocols and optional/default/return types remain present at this baseline.

Public exports already delegate ownership through re-exports: provisioning shim constants,
fix task/summary builders, NetworkManager, PodCreator, approval types, AgentRunOutcome
and selectMemoryBriefingForPod. packages/daemon/src/pods/index.ts:1–6 re-exports the
manager factory and public ContainerManagerFactory/PodManager/PodManagerDependencies;
other index exports are existing independent domain repositories/services. Existing
consumers still import legacy manager/index paths for these public types.

The historical PodManager interface omits the existing deleteSeriesWithCascade object
entry. Source semantic comparison for32 retains that excess-property diagnostic and
the existing revalidation callback Promise<void> mismatch; stale memory-briefing
reviewer protocol diagnostics are now owned in admission-memory-briefing.ts. These
are current compatibility baseline facts, not changes made in this research.

## Construction and reference timing

createPodManager starts:658. Its109statements(:659–1845) are captured collaborator
destructuring, domain factory calls, returned binding aliases and startup delivery
polling.32movement audit proves every original31construction/startup statement remains
token-identical/in order after the added effect-free admission constructors.

Early captured dependencies are destructured:659–688. Completion guards and dependent
owner(:689–697) precede provisioning tools/materials and execution context(:699–708).
Validation environment/delivery provider/host retry then runtime context/merge queue/
resource infrastructure follow(:710–829). All original state creation occurs here:
queue/poller maps, validation abort/intent sets, workspace recovery maps/coordinator,
pause state, active agent runs, provider lineage, advisory slots and lease allowances.
Their existing domain owners retain actual instances and per-manager identities.

Completion events(:833–840) precede infrastructure recovery/resource advisory/approval
readiness/workspace fences/delivery scanners and PR/watchdog/branch/fix owners
(:841–978). Validation controls(:980–1002) capture their original callbacks before
delivery polling(:1003–1021). The original resumeMergePolling() startup effect is:1024.
Commit polling, runtime credentials, reviewer and admission memory context then follow
(:1025–1060). Workspace transfer/continuation/provider controls/preservation/completion
owners follow(:1062–1184). Their callback timing is established by the current sequence,
including lazy forwarders for functions constructed later.

Validation components(:1186–1283), artifact finalizer(:1285–1298), complete validation
and revalidation delivery/trigger composition(:1299–1435), provisioning and agent
composition(:1437–1544), approval composition(:1545–1609) and fix controls(:1610–1620)
are existing domain factories. Operator composition is consecutive:1621–1705; resource
preview and workspace command composition consecutive:1706–1810. Final admission
series/query/analysis/legacy/resolved composition is:1811–1845. Their exact arguments,
capture identities and initializer text are stored, not approximated by this narrative.

No provisioning/event-loop/retry/approval/delivery/resource-cleanup algorithm remains
inside this factory body after32; all such callbacks are returned by existing owners.
Calls to factories do capture the original live dependency object through each narrow
observed structural port. Those original live reads differ from destructured service
captures and are not interchangeable. Startup resumeMergePolling is an existing
effect inside construction; grouping other effect-free calls does not imply that
effect can move before its current dependencies.

## Public return object and dynamic receiver paths

The return object is:1847–2246, with73entries in original order. All named workflow
bodies are delegates or intentional service projections; shorthand touchHeartbeat and
getReviewerExecutor retain original functions directly. getValidationEnvironment
(:2068–2071) reads stored pod then
projects environment through existing captured helpers. It is a service projection,
not a separate validation algorithm.

Only triggerValidation(:1986–1998) has a body longer than ten lines:13lines/one return
statement. It constructs the existing five lazy receiver-forwarding callbacks for
triggerValidation/assertCanRework/approveSession/consumeAgentEvents/handleCompletion
and calls validationTriggerWorkflow.triggerValidation with original pod/options.
revalidateSession forwards approval through its original lazy receiver callback;
continuation resume, extensions/update-from-base and other already extracted controls
likewise preserve dynamic property lookup. Current .call(this) entries and lazily
forwarded callbacks remain visible in the saved full source. No bound manager copy is
substituted by this research.

All other method bodies are at most ten lines, with single thin dispatch except the
small validation environment projection noted above. Original async declarations,
optional/default values and explicit this forwarding determine promise/receiver timing.
The full73member inventory records method/shorthand shape and exact body source.

## Remaining domain references to public manager types

Source search of packages/daemon/src/pods non-test modules finds these manager-path
dependencies, alongside the legitimate public index re-export:

- pod-bridge-impl.ts:51 imports ContainerManagerFactory and PodManager;
  SessionBridgeDependencies(:67–88) uses both. The bridge consumes exactly these manager
  properties in current source: getLaunchConfiguration, getReviewerConfig,
  touchHeartbeat, notifyEscalation, getSession, getReviewerExecEnv,
  getReviewerExecutor, revalidateSession, getProjectMemoryScope and optional
  getValidationEnvironment. Actual calls remain on captured podManager, including
  optional property checks, so receiver/optionality/return protocols matter.
- memory-candidate-recorder.ts:57 types optional launchContext through
  import('./pod-manager.js').PodManager['getLaunchMemoryContext']. Current extraction
  reads it live only for native pods(:175–185), obtains profile/project scope/reviewer
  and then uses the returned reviewer for serialized inference(:230 onward).
  admission-contracts.ts already names the same AdmissionLaunchMemoryContext shape,
  and admission-memory-context.ts owns its construction. Recorder's independent
  listener/processed/in-flight sets/reviewer slot are outside this manager extraction.

Current domain workflow files otherwise use explicit domain contracts/ports; the
AST scope here is manager-path references in the pods domain, not an assertion that
API/bootstrap callers cannot refer to the public API. No new runtime import cycle is
introduced by this research. Stable public input/output interfaces and narrow internal
ports are distinct current responsibilities.

## Existing proof and tests

32's unchanged1,192public manager cases pass before frozen qualification; same73names/
order and all27moved bodies/defaults/full recipes pass. Direct91-suite selection passes
680cases, including38new cases and six real SQLite reopen boundaries. Earlier owner
tests cover mutable map/timer/semaphore identity and cleanup, deferred receiver and
live fields. Relevant existing tests for remaining references include
pod-bridge-validation.test.ts, pod-bridge-memory.test.ts,
pod-bridge-task-summary.test.ts, memory-candidate-recorder.test.ts and
validation-environment.test.ts and the public manager suite. This research has
not executed new33tests or claimed final architectural completion.

The finite roadmap assigns stable public contracts, composition/delegate consolidation
and remaining narrow cross-workflow ports to33.34owns final reconciliation of all327
baseline units/73members/mutable owners and final frozen uncached clean pushed
qualification. Required manager finish line is<=1,500lines, public bodies<=10lines,
composition/projections/delegates with no remaining algorithms, no domain imports of
public manager/broad manager dependency bags and tested owned cleanup. These are
outstanding gates, not waived by32's smaller manager or passing compatibility suite.

## References and related research

- Current source:packages/daemon/src/pods/pod-manager.ts at commit above.
- Full declaration/construction/public inventory:.autopod-data/facade-composition/
  research-inventory.json and before-manager.ts.
- ../plans/2026-10-18-pod-manager-remaining-roadmap.md.
- ../plans/2026-10-19-pod-manager-admission-queries.md.
- 2026-10-19-pod-manager-admission-queries.md.

## Open questions

None about current source shape and observed manager-path consumers. Next authorized
phase after32qualification is a concrete33plan matching the original size/ownership/
type boundaries, exact initialization/receiver timing and final34audit requirements.
No33implementation is part of this descriptive artifact.

## Follow-up Research — 2026-10-19 qualification

32completed on the exact researched implementation2bbc454a, with all2,191package/
script hashes and six roots unchanged. Full uncached qualification passes9,040Vitest
cases/597passing files plus35Node cases, same ten inherited gates;304affected suites
pass5,450cases/four identical gates. No33product source edits occurred during research.
Next is the concrete33plan under standing grouped approval, followed by final34audit.

## Follow-up Research — verified existing test paths

The original narrative used two conceptual test filenames that do not exist as
standalone suites. Live rg inventory confirms bridge coverage is split across
pod-bridge-validation/pod-bridge-memory/pod-bridge-task-summary.test.ts; trigger entry
is covered by unchanged public/workflow suites. Correct paths are used in33direct
selection, whose command is saved. No test selection was silently dropped.

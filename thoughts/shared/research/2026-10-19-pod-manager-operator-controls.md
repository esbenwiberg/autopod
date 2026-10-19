---
date: 2026-10-19T01:38:07+02:00
researcher: Codex
git_commit: 79b9f012befe7c84219b727df40799949a4d315c
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice29: operator messages, rejection, pause/nudge/kill, escalation and credential/tool controls"
tags: [research, codebase, pod-manager, operator-controls]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice29 research: complete operator lifecycle controls

## Question and source baseline

Locate the remaining roadmap's operator-control algorithms, mutable pause ownership,
live dependencies and receiver calls after28's fix-cycle extraction. References below
use packages/daemon/src/pods/pod-manager.ts at
79b9f012befe7c84219b727df40799949a4d315c. Manager is6,157 lines with73 public
members.28 product source is frozen and its full qualification is running when this
report is recorded. This research does not claim that pipeline is complete and makes
no29 product changes. Full ten-body/two-binding source and reference inventories are
saved under .autopod-data/operator-controls/.

## Messages and decision handling

sendMessage (:3439–3926) is a488-line async method with an original default automation
actor. It rejects while a pause intent exists, then applies native Goal admission
before canReceiveMessage. Goal message admission distinguishes attached native MCP
reply, host_fetch repair without a fence, achieved/stopped host_push recovery and
validation_override replies from ordinary resume. It reads launchConfiguration live.

Budget-paused messages increment the original extension count within the selected
profile cap, clear pause reason, transition running and call this.handleCompletion;
errors log/fail a nonterminal pod and rethrow.

Host-fetch credential repair resolves host auth, rejects missing credentials, records
actor/response, transitions queued and enqueues; no container injection occurs.
Host-push repair resolves credentials/worktree, settles the escalation and transitions
validating. It pushes the feature branch with maxDeletions=0, carries an existing PR
or creates a missing one using current metadata and27's base/security helpers, then
transitions validated. Linked fixes use28's completion callback. Other pods trigger
dependents, stop preview/container and defer this.approveSession when enabled.
GitCredentialError re-parks through27; other errors fail a nonterminal pod and rethrow.
This inline delivery is part of operator credential recovery, distinct from the
validation/approval delivery paths extracted in27. Its current policy remains visible.

Other source credential requests save daemon-owned delivery guidance via
persistCompletionReply and nudgeRepo, resolve the existing pending request and return.
They do not vend source credentials to the container. pendingRequestsByPod is read
live and shares the MCP pending object; no new map is constructed in this method.

Validation override messages parse/merge original overrides and settle the escalation.
All-dismissed replies transition running and call this.triggerValidation. Guidance
can begin Goal task rework, resume the task feedback stream, consume events through
this.consumeAgentEvents, persist runtime credentials and call this.handleCompletion
only when completed. Superseded continuation errors retain their identity; other
errors use original failure handling.

Ordinary escalation responses distinguish attached/detached waiter and retained run.
They persist the human reply before transition/nudge publication, resolve an attached
MCP request directly, and queue a fallback for detached/retained work. An unresolved
prior run prevents another conversation. Otherwise resume obtains original runtime/
environment/provenance/MCP setup, can start a preserved sandbox, and handles the
original missing-saved-Claude-session recovery with a fresh worker. Event outcome,
credential persistence and completion follow. No general replay or termination
guarantee is implied by this current branch.

buildDetachedMcpFallbackMessage (:268–280) is the pure original13-line formatter for
closed original MCP response streams; it retains the label/text and duplicate-warning
wording. It has no external references.

## Rejection

rejectSession (:3932–4029) admits validated/failed/review_required, begins original
Goal task rework, records actor-labelled rejection/attempt reset and feedback, then
transitions running. It restarts the existing container, calls this.refreshNetworkPolicy
for local targets, resumes task feedback, consumes events, persists credentials and
completes only on completed outcome. It retains superseded error identity and existing
failure rollback. No live deps fields appear; three dynamic receiver calls are used.
The original REWORK_IN_PROGRESS_PREFIX, actor/feedback/attempt policy helpers are
already domain-owned and enter this method through the existing imports/callbacks.

## Pause intent and quiescence

pauseIntents (:1628) is one original Map<string,symbol>, created before later agent
run tracking/composition. Agent event consumption also captures this exact map.
PAUSE_QUIESCENCE_TIMEOUT_MS (:1655) is10,000. Their current creation points are distinct;
only the map owns mutable state.

pauseSession (:4031–4104) rejects duplicate/invalid pause, saves a unique token and
suspends the selected runtime or sends live native Goal control pause. A failed suspend
retains/relinquishes its intent based on the active run's settlement. After suspend it
waits for the current/replacement activeAgentRuns token, racing settled against the
original common10s deadline. Each local timeout is cleared. Timeout reports an error
and retains the intent until the exact old run settles; a replaced intent token
cannot be removed by that stale callback. Success transitions paused/manual, removes
its own intent and emits completion. Active runs are the existing24-owned shared map,
not operator-owned duplicate tracking. No dynamic this use exists.

nudgeSession (:4106–4119) checks canNudge, queues the exact message and emits/logs it;
it does not directly resume a conversation.

## Kill lifetime and bulk control

killSession (:4121–4263) checks deletion ownership, clears preview timer, awaits preview
proxy stop and stops merge polling before reading/canKill admission. It then transitions
killing and aborts validation. Preserve that original preliminary-effect order.

The cleanup closure uses the captured lifecycle generation. Native Goal cancellation,
sidecar cleanup, test branches, runtime credential recovery, container kill/conditional
id clear, network destruction, runtime abort, worktree cleanup/clear and host runtime
state cleanup occur in the original order with existing fences/catches. It races the
closure against a local30s timeout and clears its own timer in finally. The original
cleanup may continue after timeout; current generation checks do not establish a new
isolation/termination guarantee. A stale generation returns before final killed effects.

The final step reads/closes the active provider attempt through live
providerAttemptRepo, transitions killed with completion time, forgets original
credential lineage and emits original pod.completed summary. launchConfiguration and
providerAttemptRepo are live; there is no dynamic this use. Cleanup/resource algorithms
called by this command remain assigned30/31, through narrow original callbacks.

killAllFailed (:5490–5502) lists failed pods and invokes this.killSession sequentially,
collecting only successful ids and logging failures without aborting the batch. The
receiver is dynamic; no live dependency fields occur.

## Escalation and host tools

notifyEscalation (:4922–4930) only updates a currently running pod to awaiting_input,
with the exact supplied escalation and count increment. It contains no live deps or
receiver access and is separate from the shared pending-request map.

injectCredential (:5664–5670) always rejects with the original
SOURCE_CREDENTIAL_INJECTION_DISABLED/410 and daemon-ownership message, regardless of
its unused arguments. This is already implemented credential policy, not a new one.

installCliTool (:5672–5700) admits running pods with a container, checks command -v
for the supplied typed gh/az tool, skips present executables and invokes the original
installGhBinary/installAzViaPip callbacks, with original activity messages. These
installation callbacks are already provisioning-owned; this method is control
orchestration. No live external install is performed by this research/rewrite proof.

## References and initialization inventory

Only sendMessage/rejectSession/killAllFailed use this: respective call sets are
(handleCompletion,approveSession,triggerValidation,consumeAgentEvents),
(refreshNetworkPolicy,consumeAgentEvents,handleCompletion), and(killSession).
Narrow receiver contracts therefore have identifiable current signatures/arity.

Only three live fields appear: launchConfiguration in messages/pause/kill,
pendingRequestsByPod in messages, and providerAttemptRepo in kill. Original captured
runtime/worktree/container repositories and continuation/completion/validation/fix/
approval/credential callbacks remain separate references. Source shows no permission
to copy/replace those live objects or allocate another MCP pending map/active-run map.

Existing tests include the1,192 frozen public cases, operator-guidance-delivery.test.ts,
source-credential-boundary.test.ts, blocker-pause.test.ts, escalation-coordinator/
repository tests and agent run/continuation tests.28's216 inherited regression paths
were expanded to226 with5,011 passes/four inherited gates. These local tests use
controlled provider/container adapters and native local repositories; they do not
prove live comment messages, source credential vending, cloud control or installation.

Related artifacts: ../plans/2026-10-18-pod-manager-remaining-roadmap.md;
../plans/2026-10-19-pod-manager-fix-cycles.md;
2026-10-19-pod-manager-fix-cycles.md. Full goal remains through34;30 covers resource/
network/preview ownership,31 workspace/recovery,32 admission/queries,33 facade/types
and34 final reconciliation/qualification.

## Exact current declarations

| Kind | Symbol | Lines |
|---|---|---|
| function/method | `buildDetachedMcpFallbackMessage` | 268–280 |
| function/method | `sendMessage` | 3439–3926 |
| function/method | `rejectSession` | 3932–4029 |
| function/method | `pauseSession` | 4031–4104 |
| function/method | `nudgeSession` | 4106–4119 |
| function/method | `killSession` | 4121–4263 |
| function/method | `notifyEscalation` | 4922–4930 |
| function/method | `killAllFailed` | 5490–5502 |
| function/method | `injectCredential` | 5664–5670 |
| function/method | `installCliTool` | 5672–5700 |
| binding | `pauseIntents` | 1628–1628 |
| binding | `PAUSE_QUIESCENCE_TIMEOUT_MS` | 1655–1655 |

## Open questions

None about current scope/location. After28 qualification, next action is the concrete
29 plan covering allten complete bodies/two bindings, original message lifetimes,
shared pause/pending/run state, live fields and exact dynamic receiver delegation.
The488-line sendMessage body is below the per-owner size bound with narrow contracts;
the full lifetime, not a helper-only subset, belongs to this milestone.

## Qualification follow-up — 2026-10-19

28 subsequently passed qualification at the same product baseline above:226 affected
suites/5,011 passes/four inherited gates; full frozen uncached pipeline8,865 Vitest
passes/554 passing files/same ten gates plus35 script tests. All2,097 package/script
hashes and six root controls match. The plan/roadmap now mark28 complete. Six
milestones remain29–34; next phase is the concrete29 plan. This update changes no
source finding and does not imply that the full goal is complete.

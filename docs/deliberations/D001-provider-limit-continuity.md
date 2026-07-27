# D001: Provider-limit continuity

## Question

How should Autopod let an agent-driven pod continue after its LLM provider subscription or quota is exhausted, without losing repository work, task traction, or operational context?

## Current thesis

Treat recognized provider exhaustion as a recoverable interruption rather than an ordinary terminal failure.

The product should expose two distinct continuations:

1. **Continue with the same provider** after quota resets or credentials change. Preserve the pod, worktree, runtime session identifier, and lifecycle context; resume the native model session when that provider/runtime supports it.
2. **Continue with another provider** when waiting is undesirable. Preserve the worktree and pod lineage, but start a fresh provider session with a bounded durable handoff assembled from the original task, repository state, agent events, plan/progress, task summary, and the exhaustion point. Cross-provider continuation cannot transfer the vendor's native hidden session, but it can transfer Autopod's persisted conversation/activity history and repository evidence.

Materialize that handoff as an Autopod-managed, size-bounded document, make the successor runtime read it through generated system instructions, and protect it from commits. The existing `.autopod/pi-handoff.md` mechanism demonstrates the required two-layer exclusion: host worktree `info/exclude` plus the reconstructed in-container `.git/info/exclude`.

Failover policy is configurable. An ordered eligible target list may be attached to a profile and/or shared provider account. The provider account supplies a reusable default chain; a profile-level policy replaces that chain entirely rather than merging with it. When a matching target exists, Autopod may fail over automatically under that configured authority; when no target is configured or eligible, it pauses for operator choice. Provider switching remains auditable and must not be disguised as validation rework.

Cross-provider continuation should retain the same logical pod ID, but only after introducing an immutable **provider-attempt ledger**. The pod's current runtime/model fields may identify the active attempt for compatibility; prior provider account, runtime, model, session ID, start/end timestamps, terminal classification, token/cost usage, and handoff artifact must remain separately attributable. Same-pod continuation is unsafe if implemented as field overwrite alone.

## Desired gain

Observable success means:

- a provider-limit failure leaves all repository changes and pod evidence recoverable;
- configured failover automatically selects an eligible alternate target, while unconfigured exhaustion pauses rather than fails terminally;
- an operator can continue on the same provider, or select an eligible alternate provider/model, without manually recreating the task or branch;
- same-provider continuation resumes the recorded native session where supported;
- cross-provider continuation starts from the existing worktree with a visible handoff and lineage, not an empty recreation;
- validation, cost, attempt, and audit history remain attributable across the interruption;
- unrelated agent failures are not presented as quota recovery.

## Context and evidence

- `packages/shared/src/types/runtime.ts` exposes `spawn()` and `resume()` but has no typed provider-exhaustion outcome or continuation target.
- `packages/daemon/src/runtimes/claude-stream-parser.ts`, `codex-stream-parser.ts`, and `pi-rpc-parser.ts` normalize provider errors into generic fatal `AgentErrorEvent`s. Provider quota is not classified.
- `packages/daemon/src/pods/pod-manager.ts` transitions any fatal agent event to `failed`. Its public `resumePod()` operation is token-free downstream recovery only: retry PR delivery or revalidation; it does not resume agent execution.
- Forced validation/rework in `pod-manager.ts` re-provisions, clears Claude/Codex/Pi session IDs, and deliberately fresh-spawns with a rework prompt. It preserves the worktree only when prior work may exist.
- `packages/daemon/src/pods/recovery-context.ts` preserves the original task plus a short git log and diff stat. This is useful but insufficient as a cross-provider semantic handoff because it omits the durable plan, progress, event evidence, task summary, and explicit interruption reason.
- `packages/daemon/src/pods/event-repository.ts` retains ordered pod events, including normalized agent activity. `event-bus.ts` currently persists the raw event before sanitizing only the broadcast copy, so a failover handoff must explicitly sanitize selected stored content rather than injecting the raw audit record.
- Runtime-native session continuity already exists for Claude, Codex, and Pi through persisted `claudeSessionId`, `codexSessionId`, and `piSessionId` fields on `Pod`. Pi follow-up is tied to its prior spawn config and model.
- `packages/shared/src/constants.ts`, `pod-manager.ts`, and `local-worktree-manager.ts` already define and protect `/workspace/.autopod/pi-handoff.md` with host and container `info/exclude` entries. This is a concrete precedent for a readable, non-committed failover handoff artifact.
- Provider accounts currently contain provider identity and credentials only. A cross-provider target also needs runtime/model compatibility, so account-level failover cannot safely be just an alternate credential ID without target execution metadata or a profile-level override.
- The desktop has a generic `Fork` implemented client-side in `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift`. It creates a new pod from the source branch with the same profile/model/task, but offers no provider choice, durable handoff, explicit lineage, or guarantee that unsynchronized work is included.
- Pod creation already accepts runtime/model overrides in `CreatePodRequest`, while credentials are resolved through one profile/provider-account configuration. Alternate-provider eligibility therefore spans runtime/model selection and credential/profile authority.
- ADR-033 keeps vendor runtimes as first-class siblings and adds Pi as a provider-neutral runtime; this supports provider choice but does not define failover semantics.
- ADR-007 favors queue-driven recovery through normal provisioning rather than a second duplicated setup path. Provider-limit recovery should likely reuse that principle.

## Boundaries and authority

- Do not promise byte-for-byte model-session continuity across providers; hidden context is provider-owned and non-portable.
- Do not discard or reset the existing worktree merely because provider quota was exhausted.
- Do not classify every HTTP 429 as subscription exhaustion; transient rate limits and durable quota exhaustion need separate policy.
- Do not silently incur cost on another provider or cross a provider/account boundary without explicit authority unless the user has configured an opt-in failover target.
- An exhausted pod with no eligible configured target pauses for choice; it does not terminally fail or silently rework.
- Do not overload validation `rework` or downstream-only `resume` with ambiguous semantics.
- Preserve secret isolation: handoffs may include selected, sanitized durable pod evidence, never credentials, raw audit payloads, complete hidden reasoning, or private provider state.
- Bound and structure the handoff. Prefer decisions, assistant-visible progress, tool outcomes, changed-file evidence, unresolved work, and the terminal provider error over an unbounded transcript dump.
- Human authorization is required for automatic failover policy, eligible provider/account scope, and any material cost boundary.

## Pressure log

### Round 1 — incumbent behavior and blast-radius investigation

**Pressure applied and why it could change the thesis**

Investigated runtime adapters, parsers, pod failure/recovery paths, existing resume/rework/fork actions, provider accounts, and ADRs. If native cross-provider session portability or an existing complete continuation operation existed, a new recovery concept would be unnecessary.

**Evidence**

- All runtime errors collapse into generic fatal events before pod lifecycle handling.
- Native session IDs are persisted and already used for crash recovery and follow-up turns.
- Fatal agent errors park the pod as `failed`; the container/worktree may still contain valuable state.
- Current `resume` does not run the agent. Current rework intentionally destroys native session continuity. Current desktop fork is a shallow recreation with no provider switch contract.
- Provider/runtime/model are fixed on the pod record during a run, though force rework can re-resolve them from a changed profile.

**What survived**

- The problem is real and is not solved by current Resume, Rework, or Fork behavior.
- Same-provider and cross-provider recovery require different continuity guarantees.
- Existing worktree preservation and queue-driven recovery are strong foundations.

**What changed**

- “No session losses” must be split into native session preservation for same-provider continuation and explicit synthesized handoff for cross-provider continuation.
- A single generic “switch provider” button is insufficient without error classification, eligibility, authority, and audit semantics.

**New unknowns**

- Whether the first product boundary should require an explicit operator choice every time, or support preconfigured automatic failover.
- Whether cross-provider continuation should mutate the same pod execution identity or create a child attempt/pod with explicit lineage.
- Exact provider error signatures and retry/reset metadata available from each CLI/runtime.

### Round 2 — concrete failover-handoff and authority boundary

**Pressure applied and why it could change the thesis**

Tested the proposed "inject the history in a gitignored document" specimen against event persistence, sanitization, provisioning, and provider-account contracts. This could invalidate cross-provider continuity if Autopod lacked useful history, if the artifact could leak into commits, or if a configured account lacked enough information to select a compatible runtime/model.

**Evidence**

- Ordered normalized agent activity is durable in the event repository, alongside pod plan, progress, task summary, validation state, and git evidence.
- Stored events are raw audit records; only event-bus broadcasts are currently sanitized. Raw replay is therefore unsafe, but curated re-processing through the sanitizer is feasible.
- Autopod already writes `.autopod/pi-handoff.md` and excludes it independently in both host and container git metadata. The same mechanism can safely carry a managed failover handoff.
- Provider accounts are auth records, not execution profiles: they contain provider identity and credentials but no complete runtime/model target.

**What survived**

- Yes: practical history can be transferred to a new provider in a managed non-committed document and referenced from system instructions.
- Configured automatic failover is compatible with explicit authority; pause is the safe fallback when no eligible target exists.

**What changed**

- The handoff should be a curated, sanitized, bounded reconstruction—not a raw transcript export.
- A provider-account failover setting must identify or resolve a complete target (account + runtime + model), while a profile-level policy can supply target-specific execution choices and override shared defaults.

**New unknowns**

- Whether provider switches retain one pod ID as successive provider attempts or create a linked child pod/attempt.
- Precedence when both profile and provider-account failover policies exist.
- Exact provider error signatures and reset metadata available from each CLI/runtime.

### Round 3 — Code Council on same-pod identity

**Pressure applied and why it could change the thesis**

Ran an adversarial same-pod versus linked-successor analysis grounded in lifecycle, repository, runtime, analytics, and series behavior. The mechanism could be operationally convenient yet unsafe if it destroyed immutable attribution or left stale runtime state attached to the reused ID.

**Strongest case for**

- Existing force rework already changes `runtime` and `model`, clears runtime session IDs, preserves a viable worktree, and requeues the same pod (`packages/daemon/src/pods/pod-manager.ts:10102-10183`). Same-pod reprovisioning is therefore an incumbent mechanism, not a new identity violation.
- Runtime/model/session fields are explicitly mutable in the repository (`packages/daemon/src/pods/pod-repository.ts:542-548,631-639`).
- Events, approval, validation, branch ownership, and series dependencies are keyed to the pod ID. Keeping it avoids redirecting dependents and transferring lifecycle authority to a child (`packages/daemon/src/pods/event-repository.ts:46-108`; dependency unblocking in `pod-manager.ts:5535-5620`).

**Strongest case against**

- Current quality and analytics records generally attribute one runtime/model to a pod, often reading the final mutable values (`packages/daemon/src/pods/quality-signals.ts:183`; `quality-score-repository.ts:46-61`). A bare overwrite would misattribute earlier work and cost.
- `phaseTokenUsage` distinguishes initial/rework phases, not provider attempts (`packages/shared/src/types/pod.ts:54-65`; `pod-manager.ts:1536-1555`). Existing aggregate counters cannot explain which provider produced which work.
- Runtime adapters retain maps keyed by pod ID. A switch must abort and drain the old runtime, persist its final session state, clear active bindings, and only then start the target runtime; updating DB fields first would allow stale runtime state to race the successor.
- `profileSnapshot` is a single value written at provisioning (`pod-manager.ts:6259`). Reusing it for the target would erase source-attempt configuration unless attempt-level snapshots are added.

**Where the arguments agreed**

The branch/worktree and logical task can safely remain one pod. The disagreement is not the ID itself; it is whether execution identity is overwritten or appended.

**Decisive variable**

Immutable per-attempt attribution. Same-pod continuation is safe with an attempt ledger and transactional runtime handoff; it is unsafe as an in-place overwrite of the only runtime/model/profile/session evidence.

**What changed**

- Adopt one logical pod ID with successive provider attempts.
- Require attempt-level provider/runtime/model/profile/session/cost/error records before enabling automatic cross-provider continuation.
- Provider exhaustion does not increment validation rework or erase the source session; it closes one provider attempt and opens another.

**New unknowns**

- Exact provider error signatures and reset metadata available from each CLI/runtime.
- Whether the paused-no-target condition needs a dedicated lifecycle state or an expanded pause reason.

**Configuration precedence decision**

The provider account supplies the reusable default failover chain. A profile-level failover policy replaces it entirely; policies are never implicitly merged.

### Round 4 — provider-error classification feasibility

**Pressure applied and why it could change the thesis**

Checked current public provider documentation and Pi RPC behavior for stable quota-exhaustion signals. Automatic failover is unsafe if it cannot distinguish a durable subscription limit from transient throttling, outage, authentication failure, or malformed credentials.

**Evidence**

- Pi RPC explicitly separates transient automatic retry from final settlement. It emits `auto_retry_start`, `auto_retry_end` with `success`, `attempt`, and `finalError`, followed by `agent_settled`; it also supports `get_messages`/`get_entries` for conversation reconstruction. Source: [Pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).
- OpenAI documents Codex usage windows, credits, `/status`, and behavior after limits, but the public pricing documentation does not promise one stable CLI error code for subscription exhaustion. Source: [Codex pricing](https://developers.openai.com/codex/pricing).
- GitHub documents temporary Copilot rate limits separately from exhausted included/additional usage, but does not document a stable Copilot CLI machine error contract in the reviewed material. Source: [GitHub Copilot usage limits](https://docs.github.com/en/copilot/concepts/usage-limits).
- Reviewed Anthropic material did not establish a stable documented Claude Code CLI quota error schema. Existing Autopod Claude integration also captures a mixture of structured stdout errors and unstructured stderr.

**What survived**

- Conservative automatic failover is feasible after provider-native transient retries settle, when an adapter recognizes a tested definitive exhaustion signature.
- Pi offers the strongest structured foundation and can expose final retry failure plus conversation entries.
- Same-pod handoff does not depend on every provider exposing a reset timestamp.

**What changed**

- Classification must carry confidence and category rather than a boolean: at minimum `transient`, `quota_exhausted`, `auth`, `provider_unavailable`, and `unknown`.
- Only `quota_exhausted` with a definitive adapter match may trigger configured automatic failover.
- Ambiguous 429s, unknown CLI text, auth failures, and outages pause with the evidence surfaced; they do not silently switch providers.
- Provider adapters need fixture-backed classifiers so upstream CLI text changes fail closed.

**Remaining unknowns**

- Exact signatures will evolve by CLI version; this is an implementation-maintenance concern, not a blocker, because unknowns fail closed to pause.
- A dedicated lifecycle state is optional. The smallest coherent model is an expanded pause reason plus an allowed pause-to-queue reprovision transition and explicit provider-attempt events.

## Current claim ledger

| Claim | Status | Evidence | Falsifier |
| --- | --- | --- | --- |
| Current failed-pod Resume cannot continue agent execution. | supported | `pod-manager.ts::resumePod()` only retries delivery or validation. | An agent-resume branch in the daemon/API not found by the scan. |
| Rework loses native model-session continuity by design. | supported | Forced rework clears all three persisted session IDs and calls `runtime.spawn()`. | A rework path that retains and invokes the prior native session. |
| Same-provider continuation can often preserve native session state. | supported, runtime-dependent | Claude/Codex/Pi session IDs and resume paths already exist. | Provider CLI invalidates exhausted sessions or state is unavailable after the failure mode. |
| Cross-provider hidden conversation state is not portable. | supported | Runtime session formats and IDs are provider-specific; common interface exposes no export/import. | A supported provider-neutral session serialization accepted by all target runtimes. |
| Worktree plus curated pod evidence can preserve practical traction across providers. | supported in mechanism; usefulness needs validation | Durable ordered events, plan/progress/summary, git state, and the existing protected handoff-file pattern provide the inputs and transport. | A realistic interrupted task where the successor cannot safely continue from the bounded artifact. |
| Raw stored event history is safe to inject directly. | rejected | Event bus persists raw events and sanitizes only broadcast copies. | Persistence is changed to store an equivalently sanitized replay representation. |
| Automatic provider failover is authorized when explicitly configured. | accepted boundary | User decision: configure failover on profile/provider account; pause when absent. | Policy cannot express cost/data/account authority adequately. |
| Cross-provider continuation can safely retain one pod ID. | supported with conditions | Existing same-pod rework/requeue and pod-keyed lifecycle make it operationally natural. | Attempt-level attribution cannot be made immutable, or old runtime teardown cannot be made transactional. |
| Overwriting the pod's sole runtime/model/profile/session fields is sufficient. | rejected | Current analytics, phase usage, and profile snapshot would misattribute prior work. | All consumers are migrated to an immutable attempt record before switching. |
| Provider exhaustion can always be inferred from HTTP 429 alone. | rejected | Public provider contracts mix transient throttling and durable usage exhaustion; stable CLI schemas are not consistently documented. | Every supported provider publishes and preserves a distinct machine-readable exhaustion code. |
| Conservative configured failover is feasible. | supported | Adapter-specific definitive matches after transient retries settle; unknown classifications pause. | Real provider fixtures cannot distinguish any durable quota condition from transient failures. |

## Convergence assessment

Converged.

The thesis is specific and bounded: preserve one logical pod and worktree; model provider runs as immutable attempts; resume native sessions only on the same provider; transfer curated sanitized history across providers; use an explicitly configured ordered failover chain; pause when absent, exhausted, ambiguous, or unauthorized. Profile policy replaces provider-account defaults.

The gain is observable through preserved work, same-pod continuity, attempt attribution, automatic configured failover, and fail-closed pause behavior. Authority and non-goals are explicit. Same-pod identity, raw-history injection, field overwrite, and 429-only classification were challenged and resolved. Remaining provider-signature churn is deferred behind fixture-backed conservative adapters. Another deliberation round is unlikely to change the direction; it would repeat implementation detail rather than alter the thesis.

## Disposition

`Shape`

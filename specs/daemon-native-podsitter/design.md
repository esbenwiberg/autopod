# Design — Daemon-native Podsitter

## Blast radius

- `packages/shared/src/types/`, `schemas/`, and `events.ts` — configuration, decision, actor, action, provider-circuit, and event contracts.
- `packages/daemon/src/db/migrations/` — durable configuration, attention/decision ledger, provider circuit, and system-sandbox run records.
- `packages/daemon/src/podsitter/` — activation evaluation, evidence construction, decision orchestration, policy, action execution, and repositories.
- `packages/daemon/src/system-sandbox/` — provider-account-backed sandbox lifecycle and structured one-shot inference.
- `packages/daemon/src/providers/` — account-first credential injection, refresh, and readback reusable without a profile or target pod.
- `packages/daemon/src/pods/pod-manager.ts` and operator API routes — actor-aware interventions without changing existing human behavior.
- `packages/daemon/src/index.ts` and `api/server.ts` — service lifecycle and Podsitter routes.
- `templates/` and image publication scripts — pinned, repo-free decision image containing supported provider CLIs.
- `packages/cli/` — configuration, activation, status, check, and decision history.
- `packages/desktop/` — settings, provider state, kill switch, and decision history.

No `Profile` field is added. Podsitter is daemon-level configuration referencing a dedicated provider account.

## Architecture

```text
pod event / periodic sweep / activation edge / provider probe due
                              |
                              v
                 Podsitter attention reconciler
                              |
              stable signature + durable single-flight lease
                              |
                              v
                  bounded redacted evidence packet
                              |
                              v
     repo-free system sandbox using dedicated provider account
                              |
                    strict one-decision JSON
                              |
                              v
     current-state CAS + activation + policy + attempt budgets
                              |
                              v
              typed internal PodManager action executor
                              |
                              v
             durable outcome, events, and operator surfaces
```

The model is the judgment layer, not the authorization layer. It can choose any action in the full-parity enum, but cannot invoke one. The daemon independently checks whether the selected action is allowed for the current status, still matches the attention signature, remains inside activation and attempt budgets, and has not already executed for the same failure signature.

## Dedicated inference account

Podsitter configuration stores an explicit target:

```ts
interface PodsitterDecisionTarget {
  providerAccountId: string;
  runtime: 'claude' | 'codex' | 'copilot' | 'pi';
  model: string;
  reasoningEffort?: ReasoningEffort;
}
```

The target must be authenticated and runtime-compatible with the provider catalog. It is independent of every target pod's profile binding. There is no fallback to pod credentials, profile credentials, daemon environment credentials, or the account's failover policy. Provider-account deletion is blocked while referenced by active or inactive Podsitter configuration.

Account-first auth preparation reuses the existing credential formats and owner locks without synthesizing a fake profile. MAX refresh-token rotation, Codex `auth.json`, and Pi `auth.json` readback update only the configured provider-account owner. Setup tokens and static credentials remain read-only. A decision run touches `lastUsedAt` but never links the account to a profile.

## System decision sandbox

The sandbox uses a daemon-owned, digest-pinned, ACR-qualified decision image in hosted mode and the equivalent local image for Docker development. It contains pinned Claude, Codex, Copilot, and Pi CLIs but no repository clone or profile warm-image content.

Each decision run:

1. Creates a durable `system_sandbox_runs` row and synthetic system run id.
2. Spawns with no volumes, ports, daemon gateway, MCP servers, pod token, git credentials, or general application credentials.
3. Applies a restricted provider-host allowlist derived from the selected provider/runtime.
4. Writes provider configuration and secret files using existing file-pointer and `0400` conventions.
5. Writes a bounded evidence prompt and invokes exactly one CLI in non-interactive mode with no configured tools.
6. Parses the CLI envelope, validates strict decision JSON, and captures token/cost telemetry when available.
7. Reads back rotating OAuth state under the provider-account owner lock.
8. Kills the sandbox in `finally` and closes the run record.

Startup reconciliation destroys system sandboxes left active by a daemon crash. A system sandbox never appears as a normal Pod and can never become a Podsitter candidate.

The configured image is mandatory for hosted inference. Missing image, unsupported runtime, invalid credentials, spawn failure, malformed output, and cleanup failure are visible run outcomes; none silently falls back to daemon-side SDK inference.

## Evidence packet

Evidence is assembled by the daemon and treated as untrusted data. It includes bounded, credential-redacted versions of:

- pod status, timestamps, heartbeat/activity, pause and merge blockers;
- pending escalation and prior operator messages;
- readiness review and findings;
- latest validation plus relevant validation history and required facts;
- task summary, deviations, contract, brief metadata, and series graph;
- bounded agent/build log tails and recent durable events;
- bounded diff plus deterministic excerpts from touched files when needed;
- provider attempts, token/cost totals, attempt caps, and worktree state;
- prior Podsitter decisions/actions for this pod and failure signature.

Every section carries a stable evidence reference and truncation marker. Secrets and raw provider errors are sanitized before prompting. If truncation or unavailable evidence prevents a responsible decision, the model must choose `report` or `no_action`; the daemon does not let the model fetch more data or use tools.

The system prompt contains the versioned Podsitter operating policy: reason per pod, prefer the smallest useful intervention, do not blind-retry, preserve branch hygiene, state remaining risk, and stop when evidence is speculative. Evidence is delimited as untrusted and cannot change the decision schema or policy.

## Decision contract

One decision proposes at most one action:

```ts
interface PodsitterDecision {
  contractVersion: 1;
  attentionSignature: string;
  action: PodsitterAction;
  arguments: Record<string, unknown>;
  reason: string;
  evidenceRefs: string[];
  confidence: 'low' | 'medium' | 'high';
  remainingRisk: string;
  stopCondition: string;
}
```

The action enum covers full current Pi Podsitter parity:

- `no_action`, `report`;
- `approve`, `reject`, `tell`, `nudge`;
- `dismiss_validation_finding`, `guide_validation_fix`;
- `extend_budget`, `kick`, `interrupt_validation`, `revalidate`, `extend_validation_attempts`;
- `approve_fact_waiver`;
- `extend_pr_attempts`, `spawn_fix`, `retry_pr`, `update_from_base`;
- `inject_credential`, `install_tool`;
- `recover_worktree`;
- `force_approve`, `skip_validation`, `force_complete`;
- `fix_manually`.

Arguments are discriminated and schema-validated per action. There is no arbitrary command, URL, path, SQL, or HTTP action. Unknown fields/actions fail closed and remain auditable.

## Full-parity policy and budgets

Full parity means every listed action is available to the model, not that every action is always legal. Deterministic policy preserves existing state-machine preconditions and adds sitter budgets:

- exactly one executed action per decision;
- approval once per pod state transition;
- validation extension `+1`, once per failure signature;
- PR-fix extension `+1`, once per CI/review signature;
- budget extension once per pod per activation window;
- kick once per stuck-state signature;
- fact waiver once per fact/signature, with exact fact id and impossibility/staleness evidence;
- worktree recovery once before fresh evidence is required;
- skip validation, force approval, and force completion at most once and only with explicit failed phases, manual evidence references, and remaining-risk text;
- no second rescue for the same signature unless new durable evidence changes the attention signature;
- configurable global decision/action ceilings per activation window and one system-sandbox inference at a time.

Before execution the service re-reads the pod, recomputes the signature, verifies the configuration generation and activation window, and reserves the action idempotency key transactionally. A race, disable, expiry, state change, or duplicate turns the decision into `superseded` or `not_executed` rather than an action.

The executor calls internal typed services directly. It does not call the daemon's HTTP API with a bearer token. Existing human routes continue to work and supply a human actor.

## Actor provenance

Operator methods receive an explicit actor rather than hardcoding `human`:

```ts
type OperatorActor =
  | { type: 'human'; userId: string; displayName?: string }
  | { type: 'automation'; id: string }
  | { type: 'podsitter'; decisionId: string; providerAccountId: string; model: string };
```

Approvals, escalations, fact decisions, validation waivers, force actions, retries, recovery, and activity events record the actor. Existing API callers default through authenticated human context; existing `autoApprove` uses automation. Podsitter never impersonates a human. PR bodies and readiness findings continue to expose validation waivers with the correct actor.

## Activation and kill switch

Podsitter is disabled by default. Configuration supports:

```ts
type PodsitterActivation =
  | { mode: 'always' }
  | {
      mode: 'recurring';
      cronExpression: string;
      durationMinutes: number;
      timeZone: string;
    };

interface PodsitterAuthorization {
  enabled: boolean;
  activation: PodsitterActivation;
  authorizedUntil: string | null;
  generation: number;
  profileScope: string[] | null; // null means all profiles
}
```

A recurring activation starts at each five-field cron occurrence and remains active for `durationMinutes`, including cross-midnight windows. `authorizedUntil` caps both modes. Invalid or unknown IANA zones fail configuration. Daemon restart recomputes the current window; missed inactive periods do not cause catch-up actions.

Disabling increments `generation`, cancels queued decision work, aborts/cleans an in-flight system sandbox when possible, and prevents its result from executing. Manual `check` while inactive is read-only and does not grant authority. Enabling or the start of a recurring window reconciles current state rather than replaying stale evidence.

Configuration is daemon-level and records the authenticated admin/operator who changed it. Optional `profileScope` limits candidates; it still covers scheduled/issue-watcher pods on those profiles regardless of synthetic pod `userId`.

## Attention reconciliation

The service subscribes to pod/escalation/validation/readiness events and runs a periodic sweep for stale running, provisioning, queued, and validating states. Event wakes are hints; durable repositories are authoritative.

An attention signature hashes the policy-relevant state, including status, attempt number, failure reason, failed phase/fact, escalation id/type, readiness computation, diff/review hash, series dependencies, blockers, and staleness reference timestamp. Wall-clock tick time is not included after a threshold has been crossed.

The ledger stores pending, deferred, deciding, acted, reported, superseded, and failed decisions. Leases and unique idempotency keys prevent duplicate inference/action after overlapping ticks or daemon restart. New evidence supersedes older pending signatures. Quiet terminal pods are ignored unless they block a configured series.

## Provider limits and graceful recovery

Decision-provider health is a durable circuit independent of pod status:

```text
available
  -> rate_limited
  -> quota_exhausted
  -> auth_failed
  -> unavailable
```

Provider errors use the existing sanitized runtime classifier where possible and retain `retryAfter`. Behavior:

- transient rate limit: honor `Retry-After`; otherwise 1m, 5m, 15m, then 30m capped backoff;
- definitive quota/session limit: honor a provider reset timestamp; otherwise 5m, 15m, 30m, then 1h capped probes;
- provider outage: 1m, 5m, 15m, then 30m;
- authentication failure: visible notification and a slow 30m probe cadence; never launch an interactive login;
- malformed model output: bounded immediate retry once with schema feedback, then mark the decision failed without opening the provider circuit unless provider evidence also exists.

Only one probe may reserve the provider circuit at a time. Provider failures do not consume Podsitter action budgets, pod validation attempts, PR-fix attempts, or blind-retry allowances. Pending attention remains durable and deduplicated.

While inference is unavailable, the service may continue the existing strictly deterministic ready/pass/no-threat approval path because it requires no model judgment. Waivers, messages, retries, recovery, force actions, and any ambiguous approval are deferred.

After a successful probe, the service emits `podsitter.provider_recovered`, marks the circuit available, and schedules reconciliation of pending signatures. It discards queued evidence, rebuilds each candidate from current repositories, and acts only if the signature is still current. Recovery does not burst: decisions drain serially under normal window and rate budgets.

## Persistence

One migration with the next unique prefix introduces:

- `podsitter_config` — singleton configuration, activation, dedicated decision target, scope, generation, budgets, and updater identity;
- `podsitter_attention` — current and historical signatures, state, lease, first/last seen, and linked decision;
- `podsitter_decisions` — evidence hash/version, provider target, model output, parsed action, reason, outcome, token/cost telemetry, and execution timestamps;
- `podsitter_action_audit` — idempotency key, actor, action arguments with secrets excluded, policy result, daemon result, and failure signature;
- `podsitter_provider_state` — classification, consecutive failures, retry/reset time, probe lease, and recovery time;
- `system_sandbox_runs` — backend target, container id, lifecycle outcome, cleanup state, and decision link.

Raw prompts, credentials, full logs, and full diffs are not persisted. Evidence hashes and bounded redacted excerpts are sufficient for audit. Retention follows existing pod/event retention conventions; active idempotency rows are never deleted while their pod remains non-terminal.

## API and CLI

Authenticated admin/operator routes:

- `GET /podsitter` — redacted configuration, activation status, provider circuit, queue counts, and last action;
- `PUT /podsitter/config` — dedicated account/runtime/model, activation, expiry, profile scope, and budgets;
- `POST /podsitter/enable` — enable using configured activation;
- `POST /podsitter/disable` — atomic kill switch;
- `POST /podsitter/check` — reconcile now; read-only when inactive unless explicitly enabled;
- `POST /podsitter/provider/probe` — bounded manual provider probe, still circuit-single-flight;
- `GET /podsitter/decisions` and `GET /podsitter/decisions/:id` — redacted decision/action history.

CLI:

```text
ap podsitter configure --account <id> --runtime <runtime> --model <model>
ap podsitter on --always [--until <iso|duration>]
ap podsitter on --cron "0 20 * * *" --duration 12h --timezone Europe/Copenhagen [--until ...]
ap podsitter off
ap podsitter status [--json]
ap podsitter check
ap podsitter probe
ap podsitter decisions [--pod <id>] [--json]
```

The existing local Pi `/podsitter` command is not silently redirected. Documentation distinguishes local-session and daemon-native operation during transition.

## Desktop

Add a Podsitter settings surface using existing provider-account/model controls:

- dedicated authenticated account picker;
- compatible runtime/model selection;
- always-on or recurring activation editor with timezone/duration;
- optional expiry and profile scope;
- visible enabled/active/inactive/provider-limited state;
- immediate kill switch;
- recent decisions with evidence references, reason, action, outcome, and remaining risk.

The desktop never receives provider credentials or raw prompts. Mobile web is deferred.

## Events and notifications

Add durable events for attention queued, decision started/completed/failed, action executed/rejected, provider limited/recovered, activation changed, and system-sandbox cleanup failure. Existing WebSocket and notification infrastructure may surface them. Notifications are rate-limited and aggregate repeated provider-limit states.

## Failure behavior

- No dedicated account/image: service remains configured but unavailable and visible; no credential fallback.
- Sandbox spawn/exec failure: decision remains retryable under bounded infrastructure backoff; no action executes.
- Invalid model output: one schema-repair retry, then report failure.
- Daemon crash after action reservation: startup reconciliation inspects the current pod and action audit before deciding whether the reservation completed; it never blindly repeats a side effect.
- Disable/expiry during inference: result is retained as not executed.
- Action races with lifecycle: current-state check fails closed and records superseded.
- Cleanup failure: run is marked leaked and startup/periodic reaper retries cleanup without blocking pod lifecycle.

## Execution plan

1. Add contracts, persistence, activation evaluation, and durable leases.
2. Build the account-first system decision sandbox and system image boundary.
3. Make operator interventions actor-aware and expose a typed internal executor.
4. Build the Podsitter evidence/decision/controller/API loop, including provider circuit recovery.
5. Add CLI configuration and operations.
6. Add desktop configuration, status, kill switch, and history.

Briefs 01–04 form the daemon dependency chain. CLI and desktop are independent consumers after the API contract lands.

## Reference reading

- `skills/podsitter/SKILL.md` in the Pilot repository — current reasoning/action policy.
- `packages/daemon/src/pods/pod-manager.ts` — lifecycle invariants and operator actions.
- `packages/daemon/src/pods/readiness-review.ts` — deterministic readiness evidence.
- `packages/daemon/src/validation/container-reviewer-runner.ts` — live-container reviewer precedent.
- `packages/daemon/src/providers/env-builder.ts` — provider credential injection.
- `packages/daemon/src/providers/credential-persistence.ts` — owner locks and OAuth rotation.
- `packages/daemon/src/runtimes/provider-error-classifier.ts` — sanitized quota/rate-limit classification.
- `packages/daemon/src/containers/sandbox-container-manager.ts` — Azure system-sandbox backend.
- `packages/daemon/src/scheduled-jobs/scheduled-job-manager.ts` — cron parsing and daemon scheduler precedent.
- `packages/daemon/src/issue-watcher/issue-watcher-service.ts` — event plus periodic reconciliation precedent.

## Decisions

- Podsitter is daemon-native; the existing Pi extension is not hosted verbatim.
- LLM judgment runs only in a repo-free system sandbox.
- Inference uses one dedicated provider account and never target-pod auth.
- The first release exposes full Pi Podsitter action parity under deterministic policy and budgets.
- Activation supports always-on and recurring windows, optional expiry, and an immediate kill switch.
- Provider limits defer and later resume current work without consuming intervention attempts.

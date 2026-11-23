# #665 part 1: Docker host-capacity probe outages are transient, not fatal — Implementation Plan

Research: `thoughts/shared/research/2026-11-23-665-docker-capacity.md`.
Baseline `e732fbb45`, branch `local-pod/issues-1122/665a`.

## Overview

"Docker capacity is unavailable on this daemon" is not a shortage of slots. It means
the `docker info` probe, which reads the **static host size**, failed or took longer
than 5 s. The probe runs on admission, on preview and in about 50 in-flight re-checks
(`assertCurrent`). One slow probe on a busy engine therefore fails any operation of
any composable Docker pod. In the reported case it hit the validation-retry resume
before the agent turn started, and the pod became `failed`.

The fix classifies the probe outcome and makes each caller act on that class:

| Probe outcome | Class | Admission/preview | In-flight work (validation, resume, MCP, …) | New container (provisioning) |
|---|---|---|---|---|
| Live `info` | verified | as today | as today | as today |
| `info` failed, last success ≤ 30 min ago | verified (cached) | as today | as today | as today |
| `info` failed, no recent success | **transient (unverified)** | **admitted**: bounded by the last known host size or the operator ceiling; preview says it will wait | **proceeds**: the container already holds its resources | **waits in `queued`** with a labelled incident and automatic re-enqueue |
| Docker not configured; default or request exceeds the host or operator limit | **permanent** | hard refusal (as today) | error (as today) | error (as today) |

No new `PodStatus`, no `pauseReason`, no migration. This plan does not edit
`validation-trigger-workflow.ts`, `continuation-controls.ts` or `provider-continuation.ts`
(#670), or the #663 files.

## Desired end state

- A slow or failed `docker info` never fails an in-flight pod and never refuses a launch.
- Launches during an outage are admitted to the queue. Pods wait in `queued` with
  `infrastructureFailure.source = 'execution-capacity'`, `recoveryDisposition:
  'automatic_retry_scheduled'` and `retryNotBefore`. They re-enqueue automatically,
  including after a daemon restart, and provision once Docker reports host size.
  They stay killable.
- Rework from a stranded or failed pod re-queues with its preserved worktree and waits
  the same way.
- `ap run` and `ap run --preview` print a note when Docker host capacity is currently
  unverified.
- Permanent conditions keep their existing codes and messages. A null Docker client
  now reports "Docker is not configured on this daemon".
- Probe failures are logged with their cause, at most once per memo window.

## Phase 1: classify, cache and coalesce the host-capacity probe (configuration layer)

**Files**
- `packages/shared/src/types/launch-config.ts`: add an optional field to
  `ExecutionCapabilities`:
  `hostCapacity?: { state: 'live' | 'cached' | 'unverified'; observedAt: string | null; reason?: string }`
  (Docker only, omitted for sandbox).
- `packages/daemon/src/configuration/backend-capabilities.ts`
  - `createDockerHostCapacityProbe({ docker, logger?, now?, timeoutMs = 10_000, memoMs = 30_000, freshMs = 30 * 60_000 })`
    → `() => Promise<HostCapacityObservation>`:
    - single-flight (concurrent callers share one `docker.info()`)
    - memoises the last outcome (success **or** failure) for `memoMs`, so a wedged
      engine does not add a 10 s wait to every re-check
    - keeps the last successful `{ memTotalBytes, ncpu, observedAt }`. On failure it
      returns `cached` if that success is ≤ `freshMs` old, otherwise `unverified`
      (still carrying the stale host size, if one exists, as the bound)
    - `warn`-logs the failure cause (`DockerCallTimeoutError` or the error) once per
      memo window
  - `dockerCapabilities({ probe | null, privilegedSidecars, limits, defaults })`:
    - `probe === null` → `available: false`, "Docker is not configured on this daemon" (permanent)
    - `live`/`cached` → behaviour unchanged
    - `unverified` → `available: true`. Bounds are min(stale host size or ceiling,
      ceiling). `hostCapacity: { state: 'unverified', reason: 'Docker did not report
      host capacity (<cause>); new containers wait in the queue until it does' }`
    - default > bounds → permanent `available: false` (unchanged)
  - `export class ExecutionCapacityUnverifiedError extends AutopodError`
    (`EXECUTION_CAPACITY_UNVERIFIED`, 503) and `isExecutionCapacityUnverified(err)`.
- `configuration/host-components.ts`: build one probe per components instance and
  pass it to `dockerCapabilities`.
- `configuration/components.ts`: add `launchConfiguration.assertExecutionCapacity(config)`.
  For a `local` target it reads capabilities and throws
  `ExecutionCapacityUnverifiedError` when `hostCapacity.state === 'unverified'`. It
  then runs the existing `assertCurrent(config)`.
- `pods/pod-manager-contracts.ts`, `pods/provisioning-ports.ts`: add the optional
  `assertExecutionCapacity?(config): Promise<void>` to `launchConfiguration`.

**Tests**
- `backend-capabilities.test.ts`:
  - live
  - timeout → `unverified`, `available: true`, ceiling bounds
  - failure after a success → `cached` inside 30 min, then `unverified` with the stale
    host bounds
  - concurrent probes → one `info` call; a memoised failure → no second wait
  - `null` → permanent
  - default above the host size → permanent
  - the failure is logged
- `components.test.ts` / `host-components.test.ts` (real components, `info` rejects):
  - `resolveLaunch` admits a local launch with the **same digest** as with a healthy
    probe
  - `assertCurrentCapabilities(frozen)` resolves. This is the validation-retry,
    resume and MCP re-check path from the issue.
  - `assertExecutionCapacity(frozen)` rejects with `EXECUTION_CAPACITY_UNVERIFIED` (503)
  - an oversized request against a live host is still `ALLOCATION_UNSUPPORTED`

**Success criteria**: `npx pnpm --filter @autopod/shared build`; daemon typecheck;
`vitest run src/configuration/backend-capabilities.test.ts src/configuration/components.test.ts src/configuration/host-components.test.ts`.

## Phase 2: wait in the queue at the provisioning gate

**Files**
- `packages/shared/src/types/pod.ts`: new `ExecutionCapacityInfrastructureFailure`
  `{ source: 'execution-capacity'; code: 'EXECUTION_CAPACITY_UNVERIFIED'; diagnostics: string;
  attemptCount; recoveryDisposition: 'automatic_retry_scheduled'; occurredAt; retryNotBefore: string }`,
  added to `PodInfrastructureFailure`.
- `pods/pod-repository.ts`: the serializer bounds `diagnostics` (500 characters) for
  the new source.
- New `pods/execution-capacity-retry.ts` (modelled on `workspace-host-fetch-retry.ts`):
  - `scheduleExecutionCapacityRetry(pod, err)`
  - backoff 30 s, 60 s, 120 s, then 300 s (capped)
  - the timer re-enqueues only if the pod is still `queued` with the same
    `retryNotBefore`
  - activity: "Docker host capacity could not be verified (…). Waiting in the queue;
    retrying automatically in N s."
- `pods/provisioning-workspace.ts:84`: the first statement calls
  `assertExecutionCapacity ?? assertCurrentCapabilities`. Once it passes, an
  `execution-capacity` incident is cleared. This runs before any worktree, container,
  provider-attempt or `provisioning` effect.
- `pods/agent-process-workflow.ts` catch: a branch beside `GitTransientFetchError`. If
  the error is `isExecutionCapacityUnverified(err)`, the pod is not a retained-coding
  owner and it is still `queued`, schedule the retry and return. This frees the
  concurrency slot and leaves no `failed` transition.
- Wiring: `pods/agent-execution-contracts.ts`, `pods/pod-manager.ts`,
  `test-utils/agent-execution-helpers.ts`.
- `pods/local-reconciler.ts`: generalise the restart rehydration of `git-fetch` retry
  timers to `execution-capacity`.

**Tests**
- `execution-capacity-retry.test.ts`: backoff and attempt count; the timer is
  suppressed after kill, a status change or a newer schedule.
- `provisioning-workspace.test.ts`: the gate rejects before workspace effects, the pod
  stays `queued`, and the incident is cleared after a later success.
- `pod-manager.test.ts` (composable launch pod):
  - unverified twice, then verified → stays `queued` with the incident, no worktree,
    container or runtime calls, `processPod` returns; then it provisions and the
    incident is cleared
  - **recovery from the parked state:** Rework of a `failed` pod during an outage →
    `queued` with `recoveryWorktreePath` = the original worktree → waits → provisions
    with that worktree
  - kill while waiting → `killed`, and the timer does nothing
- `local-reconciler.test.ts`: the `execution-capacity` timer is rehydrated after a restart.

**Success criteria**: daemon typecheck and the targeted suites above, run in batches.
`pod-manager.test.ts` runs filtered with `-t`, then in full in the foreground.

## Phase 3: operator messaging and docs

- CLI `api/client.ts`: `getConfigurationCapabilities()` (`GET /configuration/capabilities`,
  read-only, errors ignored).
- CLI `commands/launch.ts`: for a `local` target whose `hostCapacity.state` is
  `unverified`, print to stderr for both `--preview` and run: "Docker host capacity is
  currently unverified (<reason>). The launch is admitted and will wait in the queue
  until Docker reports it." Covered in `launch.test.ts`.
- `packages/daemon/CLAUDE.md` (Container Management): a short paragraph on probe
  classes, the queue wait and the `execution-capacity` incident. Rework is named as the
  route for pods already failed by this bug.

**Success criteria**: `npx pnpm --filter @autopod/cli test -- launch`, `npx pnpm lint`,
`npx pnpm build`, the daemon configuration and pods suites in batches.

## Key decisions and trade-offs

1. **Admit during an outage, don't refuse.** Admission uses the last known host size,
   or the operator ceiling (default 128 GB). The frozen allocation does not depend on
   the bounds, so the digest is identical. Risk: a request that is too large for the
   host but within the ceiling is admitted and then fails at the gate with the existing
   permanent `ALLOCATION_UNSUPPORTED`.
2. **In-flight re-checks accept an unverified host size.** Operator limits and policy
   are still enforced. If Docker is really down, the real Docker calls fail with their
   own errors. This removes the fatal path from the issue without touching
   `validation-trigger-workflow.ts`. No bounded wait is needed there: the work is no
   longer blocked.
3. **The provisioning gate requires a live or ≤ 30 min cached host size.** It acts as
   backpressure: a pod waits in `queued` without limit (killable), with backoff capped
   at 5 min, like `git-fetch`. Container creation can still fail on a wedged engine, as
   it does today.
4. **Probe tuning.** Timeout 5 s → 10 s. Memo 30 s for success and failure, plus
   single-flight, to reduce `docker info` load from about 50 call sites.
5. **`ap recover-infrastructure` is not widened.** It is for agent-reported needs with
   preserved settlement. Pods no longer fail this way, and historical ones recover
   with `ap rework`.

## Open questions for the parent

1. Do you agree to leave `ap recover-infrastructure` unchanged (decision 5)?
2. `HOST_NETWORK_CAPACITY` (subnet exhaustion, a real slot shortage raised after
   `queued → provisioning`): follow-up issue rather than this change?
3. Desktop shows the ceiling as the maximum while the host size is unverified. Should
   I add a one-line caption from `hostCapacity.reason` in the two create sheets (Swift,
   needs a Mac test run), or defer?
4. Should I add a defensive `EXECUTION_CAPACITY_UNVERIFIED` park branch in the
   `triggerValidation` catch? It is unreachable by construction and sits in #670's file.
   I recommend no.
5. Are the numbers acceptable: 10 s timeout, 30 s memo, 30 min freshness, backoff
   30/60/120/300 s?

## Not doing

- No new pod state, pause reason or migration. No auto-retry of agent turns.
- No changes to sandbox capabilities, `HOST_NETWORK_CAPACITY` or #663/#670 files.

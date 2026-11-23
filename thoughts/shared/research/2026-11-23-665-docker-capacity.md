# #665 part 1: "Docker capacity is unavailable" during a validation retry — Research

Baseline: `e732fbb45` (origin/main). Branch `local-pod/issues-1122/665a`.
Scope: #665 part 1 only. Parts 2 (#680, fact exit code) and 3 (#675, draft PR scan
reason) are done. No live daemon or Docker was used. Everything below comes from
reading the code. The live cause of the probe failure on release `dceb1f9e` (timeout
or error) cannot be proved: the probe discards its error without logging it (§1).

## 1. Where the message comes from, and what it actually measures

`packages/daemon/src/configuration/backend-capabilities.ts:60-101`, `dockerCapabilities()`:

```ts
try {
  if (!options.docker) throw new Error('unavailable');
  const info = await boundedDockerCall(options.docker.info(), { label: 'configuration.dockerInfo', timeoutMs: 5_000 });
  memoryGb = Math.min(info.MemTotal / gib, options.limits.memoryGb);
  cpus = Math.min(info.NCPU, options.limits.cpus);
  if (!finite || <= 0) throw new Error('invalid host capacity');
  if (defaults > memoryGb/cpus) unavailableReason = 'Configured default allocation exceeds …';
} catch {
  unavailableReason = 'Docker capacity is unavailable on this daemon';   // :82
}
```

- "Capacity" here is the **static host size**: `docker info` `MemTotal` and `NCPU`,
  each capped by the operator ceiling (`settings.docker.limits`, default 128 GB and
  128 CPUs, `host-components.ts:64-77`). It does **not** count slots used by other
  pods. Nothing in this path counts memory or CPU used by running pods.
- The message is therefore produced only when:
  1. `docker` is `null` (Docker is not configured — permanent), or
  2. `docker.info()` **rejects or takes longer than 5 s** (`boundedDockerCall`,
     `containers/docker-bounds.ts:78-126`), or
  3. `info` returns non-finite or ≤ 0 values.
  The `catch {}` discards the error, so the cause is not logged.
- `docker info` walks containers, images and storage-driver state. It slows down
  when the engine is busy, for example with several pods running builds. That
  matches "other pods were running". Case 2 (a slow or failed `info` on a busy
  engine) is the only credible production cause. It is **transient**. Nothing about
  the request or the host is unsupportable.
- The probe has no cache, no coalescing and no retry. Every call issues a new
  `docker info`.

### What "slots" actually exist

| Resource | Where it is enforced | Behaviour today |
|---|---|---|
| Concurrent pods | `pods/pod-queue.ts` (`MAX_CONCURRENCY`, `index.ts:176`, default 3) | Pods wait in `queued`. This is already the "wait for a slot" mechanism. |
| Docker bridge subnets | `containers/docker-network-manager.ts`, `docker-network-capacity.ts` (`HOST_NETWORK_CAPACITY`) | Raised in `provisioning-container.ts` **after** `queued → provisioning`. The pod fails. Retained bridges are released on pressure. |
| Host memory and CPU | `dockerCapabilities` (static host size against the per-pod request) | Checks one pod's request against the whole host. It is not a pool. |

So the "transient vs permanent" distinction the issue asks for maps to:
**probe could not read host size (transient)** vs **Docker not configured / request
or default exceeds host or operator limits (permanent)**. Network-subnet exhaustion
is a different, genuine slot shortage. It is not in the reported path (§6).

## 2. How a capability failure becomes a fatal error

`capabilities.available === false` → `resolveExecution()` throws
`configurationError(reason, 'EXECUTION_UNAVAILABLE')` (status 400)
(`configuration/resolve-execution.ts:19-24`).

`resolveExecution` with **current** capabilities runs from:

- **Admission and preview**: `launch-resolver.ts:391-401` (freezes `resolvedExecution`)
  and `services.assertCapabilities(config)` (`launch-resolver.ts:191`, `:540`).
  `/launch/resolve` (`api/routes/configuration.ts:369`) serves `ap run --preview`. Plain
  `ap run` without a saved digest also resolves first (`cli/src/commands/launch.ts:317-318`).
  Series (`series-launches.ts:102-140`), watcher and scan launches use the same
  functions.
- **Every in-flight re-check**: `assertCurrent(config)` (`configuration/components.ts:175-238`).
  It re-resolves execution with current capabilities and compares the digest to the
  frozen allocation (`EXECUTION_CAPABILITIES_CHANGED`). It is exported as
  `launchConfiguration.assertCurrentCapabilities` (`components.ts:364`) and has about
  50 call sites, including:
  - `worker-runtime-credentials.ts:196` (`getResumeEnv`, end)
  - `runtime-resume-context.ts:77`, `:132` (`primeRuntimeForResume`)
  - `validation-environment.ts:42`, `:59` (before every validation run)
  - `admission-queries.ts:33-53` (MCP proxy and deployment reads from the running agent)
  - `provisioning-workspace.ts:84` (first statement of provisioning, pod still `queued`),
    `provisioning-container.ts:290`, `provisioning-workspace-population.ts:391-393`,
    `components.ts:572-578` (`prepareEnvironment`)

So a slow `docker info` can fail **any** in-flight operation of **any** composable
Docker pod. It is not limited to new launches. The re-check exists to catch operator
limit and policy changes. A running container already holds its resources, so the
host-size re-probe adds nothing for in-flight work.

## 3. The reported sequence, traced

`pods/validation-trigger-workflow.ts`:

1. Attempt 1 fails (part 2 fact) → `:1052-1057` "Validation failed (attempt 1/2) — retrying",
   "Sending validation feedback to agent…".
2. `resumeAgentWithCorrection` (`:180-225`): `transition(current, 'running')` (`:190`),
   "Agent working on fixes…" (`:197`), `taskFeedbackEvents(...)` (`:199`).
3. `taskFeedbackEvents` (`continuation-context.ts:109-140`) → `getResumeEnv` →
   `assertCurrentCapabilities` (`worker-runtime-credentials.ts:196`) → `EXECUTION_UNAVAILABLE`.
   Then `primeRuntimeForResume` (`runtime-resume-context.ts:77`) would have asserted
   again. No agent turn started: the runtime `resume/spawn` call comes after both.
4. The error leaves `triggerValidation`. The catch (`:1110-1163`) has no transient
   branch. It records `failureReason = 'Validation failed before checks could complete:
   Docker capacity is unavailable…'`, sets `transition(s2, 'failed')` (from `running`) and
   stops the container.

`validation-revalidation-workflow.ts:641` has the same fallback for the revalidation
path.

## 4. Why recovery was refused

`ap recover-infrastructure` (`pods/retained-checkpoint-recovery.ts:345-370`) accepts
only a native, settled, **failed** local Docker task. Without a predecessor it needs a
recorded infrastructure **blocker** (`podRepo.hasInfrastructureBlocker`) and a current
finalization with `phase: 'ready'`, `agentSettledAt` and `sourcePreservedAt`. Those
come from an agent `report_blocker` and the shared preservation owner. A daemon-side
probe failure records none of them. `sourcePreservationRecorded: false`
(`:688-690`) is correct for this pod. The tool is designed for agent-reported
infrastructure needs. It is not the right recovery for a daemon probe outage.

For the stranded pod, Rework (`triggerValidation({force})` from `failed`) is the
existing supported route. It re-queues with `recoveryWorktreePath = worktreePath`
(`validation-trigger-workflow.ts:346-418`). The host worktree holds the validated
source, because validation synced it back and no agent turn ran after that. Today,
however, Rework provisioning starts with the same probe (`provisioning-workspace.ts:84`).
During the outage it would have failed again.

## 5. Existing patterns to reuse

- **Queued transient retry.** `pods/workspace-host-fetch-retry.ts`: on
  `GitTransientFetchError` while `queued`, `agent-process-workflow.ts:785-789` records
  `infrastructureFailure {source:'git-fetch', recoveryDisposition:'automatic_retry_scheduled',
  retryNotBefore, attemptCount}` with backoff 30 s, 120 s, 300 s… It keeps `queued`, frees
  the concurrency slot, and a timer re-enqueues the pod. `local-reconciler.ts:262-292`
  rehydrates the timer after a restart. `provisioning-workspace.ts:461-466` clears the
  incident after success. The test pattern is in `pod-manager.test.ts:25797-25830`.
  `PodInfrastructureFailure` is a JSON column (`migrations/140`), so new variants need
  no migration. The serializer is `pod-repository.ts:443-454`. Desktop does not decode
  the pod-level `infrastructureFailure` (only the validation-result one), so a new
  variant is safe there.
- **Parks.** `review_required` parks (`validation-infrastructure.ts`
  `parkOnValidationInfrastructureFailure` / `parkOnRetryAdmission`) and `paused`
  with `pauseReason` (`budget`, `manual`, `provider_limit`). Neither is needed if
  in-flight work no longer depends on a fresh probe (plan §Approach).
- **State machine.** `running → review_required` is not allowed. `running → paused`
  and `running → validating` are allowed. `queued` accepts re-enqueue without any
  transition (`shared/src/constants.ts:103-143`).

## 6. Out of scope, noted

- `HOST_NETWORK_CAPACITY` (subnet pool exhaustion) is a real "slots in use by other
  pods" shortage. It is raised after `queued → provisioning`, where `queued` is no
  longer a valid target. Making it queue needs a state-machine or provisioning-order
  change. It was not part of the reported failure → separate follow-up.
- Startup already calls `docker.info()` for an undersized-memory warning
  (`index.ts:503-525`) and exits if Docker cannot be pinged.
- Sandbox capabilities are static (`sandboxCapabilities`) and are not affected.

## 7. Concurrent work overlap

- #663 (`validation-workspace.ts`, `workspace-transfer.ts`, push helper,
  `approval-controls.ts`): no overlap.
- #670 (`provider-continuation.ts`, `continuation-controls.ts`,
  `validation-trigger-workflow.ts` Rework teardown, agent-failure preservation): the
  plan does **not** edit `validation-trigger-workflow.ts`, `continuation-controls.ts` or
  `provider-continuation.ts`. One small branch is added to the `processPod` catch in
  `agent-process-workflow.ts`, next to the existing `GitTransientFetchError` branch.
  #670's agent-failure preservation may edit the same catch further down
  (`preserveSandboxAfterAgentFailure`). Expect a trivial textual merge at most.

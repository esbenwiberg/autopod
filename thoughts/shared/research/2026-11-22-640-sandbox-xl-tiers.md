# #640 Opt-in XL and 2XL Azure Sandboxes — Research

Baseline: `b01b2480a` (origin/main). Branch `local-pod/issues-1122/640`.
All line numbers are at the baseline.

## Summary

Sandbox sizing is described in **four places** that each stop at `L`, plus several
generic fallbacks that assume the Docker default (10 GiB):

1. Tier type + memory table + clamp helper — `sandbox-api-client.ts`.
2. Azure create payload table — `azure-sandbox-api-client.ts` (`resourcesForTier`).
3. A hard-coded `L` guard in `SandboxContainerManager.ensureManagedContainer`.
4. Default-tier parsing in `index.ts` and a literal `'XS'|'S'|'M'|'L'` in `host-components.ts`.

New launches already flow through an advertised-tier admission check
(`resolve-execution.ts`) and persist `resolvedExecution.main.memoryGb` in the frozen launch;
that value becomes `profile.containerMemoryGb` for provisioning. Legacy (no launch config)
pods fall back to `DEFAULT_CONTAINER_MEMORY_GB = 10`.

## 1. Tier catalog today

- `packages/daemon/src/containers/sandbox-api-client.ts:21` —
  `export type SandboxResourceTier = 'XS' | 'S' | 'M' | 'L';`
- `sandbox-api-client.ts:49` — `CreateSandboxOptions.tier: SandboxResourceTier`.
- `sandbox-api-client.ts:299-304` — `SANDBOX_TIER_MEMORY_BYTES` (0.5/1/2/4 GiB).
- `sandbox-api-client.ts:306` — `TIER_ORDER = ['XS','S','M','L']`.
- `sandbox-api-client.ts:308-313` — `MAX_SANDBOX_MEMORY_BYTES = SANDBOX_TIER_MEMORY_BYTES.L`
  (doc comment calls L the hard platform ceiling).
- `sandbox-api-client.ts:315-329` — `pickSandboxTier(memoryBytes, defaultTier)`: no/<=0
  hint → `defaultTier`; else smallest tier ≥ request; **above every tier → `'L'` (clamp)**.
- Unit tests: `sandbox-api-client.test.ts:24` (“clamps requests above the largest tier to L”).

## 2. Azure create payload

- `packages/daemon/src/containers/azure-sandbox-api-client.ts:1856-1894`
  `createSandboxFromDiskImage` PUTs `${groupPath}/sandboxes` with
  `resources: resourcesForTier(options.tier)`; `singleAttempt` when managed or a
  ready disk image is configured, otherwise the generic `requestData` retry (same body).
- `azure-sandbox-api-client.ts:2353-2365` `resourcesForTier`: separate literal table
  XS `250m/512Mi/5Gi`, S `500m/1024Mi/10Gi`, M `1000m/2048Mi/20Gi`, L `2000m/4096Mi/40Gi`.
- Observed allocation parsing is tier-agnostic: `getResourceAllocation` (`:475-501`) parses
  `Mi|Gi` and `m`/plain CPU; the compute-cost observer (`sandbox-container-manager.ts`
  ~`:229-245`, `pods/sandbox-compute-cost.ts`) prices observed CPU/GiB, so larger bundles
  are priced correctly without change (`docs/sandbox-compute-cost.md`).
- Errors from the PUT propagate; there is no smaller-tier fallback anywhere.
- Test anchor: `azure-sandbox-api-client.test.ts:690-737` asserts the L payload.

## 3. SandboxContainerManager

- `sandbox-container-manager.ts:84-93` options, `defaultTier?` (“default: 'L'”).
- `:101-121` config, `tier?` (“default: 'L' — the largest preview tier”).
- `:167` `this.defaultTier = options.defaultTier ?? 'L'`; `withAzureClient` `:326-328`
  maps `config.tier ?? 'L'` to `defaultTier`.
- **Ordinary spawn** `:379-405`: `pickSandboxTier(config.memoryBytes, defaultTier)`; refuses
  `memoryBytes > tier bytes` with `PREFLIGHT_INSUFFICIENT_MEMORY` (409) **before**
  `createSandbox` (because pickSandboxTier clamps to L, that refusal is what rejects >4 GiB).
- **Managed** `ensureManagedContainer` `:459-497`: precondition list includes
  `config.memoryBytes > SANDBOX_TIER_MEMORY_BYTES.L` → `managed-sandbox-enforcement-unavailable`
  (a separate hard-coded L guard), then claim row in `managed_sandbox_allocations`
  (`INSERT OR IGNORE … 'creating'`), discovery by labels (`findManagedSandbox`) and reuse;
  `createSandbox({ tier: pickSandboxTier(config.memoryBytes, defaultTier) })` at `:490-497`.
  Reuse/identity safeguards: `identity-conflict`, `identity-missing`, `create-uncertain`.
- Managed callers (`managed/runtime-composition.ts:270-296` `prepare`,
  `managed/validation-runtime.ts:250-263`, `managed/sandbox-checkpoint.ts:268`) **never set
  `memoryBytes`**, so managed sandboxes always use the configured default tier. The
  `ManagedPodRequest` (specs/managed-pod/v1) carries no size.
- Tests: `sandbox-container-manager.test.ts:450-482` (default tier, derive tier from memory,
  reject 10 GiB before allocation); `managed/sandbox-managed.test.ts:11-80` (lost create
  response reconciled, no duplicate).

## 4. Default tier configuration and capabilities

- `packages/daemon/src/index.ts:554-559` `parseSandboxTier`: literal `XS|S|M|L`, warns
  otherwise. `:639-640` reads `AZURE_SANDBOX_TIER ?? SANDBOX_TIER`. `:659` passes as
  manager `tier`; `:673` logs `?? 'L'`; `:879` `sandboxDefaultTier: SANDBOX_TIER ?? 'L'`.
- `configuration/host-components.ts:155` `sandboxDefaultTier: 'XS' | 'S' | 'M' | 'L'`;
  `:247-256` `executionCapabilities('sandbox')` → `sandboxCapabilities`.
- `configuration/backend-capabilities.ts:13-43` `sandboxCapabilities`: `memoryTiersGb` =
  all `SANDBOX_TIER_MEMORY_BYTES` values; `defaults.memoryGb` = default tier;
  `maxMemoryGb = maxTotalMemoryGb = max(tiers)`; `cpus/storage` null (no independent control).
- Shared contract `packages/shared/src/types/launch-config.ts:54-69` `ExecutionCapabilities`
  (interface, no zod; served by `configuration/components.ts:680-686` capabilities route).
  Test anchor `backend-capabilities.test.ts:6-13` expects `[0.5, 1, 2, 4]`.

## 5. Admission → frozen allocation → provisioning (new launches)

- `configuration/resolve-execution.ts:36-81` `allocation()`:
  `memoryGb = requested ?? caps.defaults.memoryGb`; rejects independent CPU when
  `caps.maxCpus === null` (`:46-50`), storage when `caps.maxStorageGb === null` (`:51-58`),
  `> maxMemoryGb` (`:59-63`), and non-advertised tier (`:64-68`), all
  `ALLOCATION_UNSUPPORTED`. Used by preview/launch (`launch-resolver.ts:400`), series
  (`series-launches.ts:102`) and admission (`components.ts:223`).
- Retry/recovery: `components.ts:212-229` `assertCurrent` re-resolves the **frozen**
  `resolvedExecution.main` as an explicit request and fails with
  `EXECUTION_CAPABILITIES_CHANGED` if the digest differs (never downgrades). Called from
  `provisioning-workspace.ts:84`, `runtime-resume-context.ts:77,132`,
  `continuation-controls.ts:105`, `recovery-fork.ts:819`.
- `configuration/launch-execution-settings.ts:134` sets
  `containerMemoryGb: config.resolvedExecution.main.memoryGb` on the execution settings.
- `pods/provisioning-container.ts:501-502` spawn
  `memoryBytes: (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * GiB`.
  `nanoCpus` comes from the launch (`:503-507`, null for sandbox).
- Other launch-derived spawns already use the frozen value directly:
  `validation/isolated-reviewer.ts:504`, `pods/artifact-checks-execution.ts:84`.

## 6. Legacy/implicit fallback sites

`DEFAULT_CONTAINER_MEMORY_GB = 10` (`packages/shared/src/constants.ts:32`):

- `provisioning-container.ts:502` — the spawn site named in the issue. For a legacy
  sandbox profile with `containerMemoryGb = null`, today 10 GiB → clamp L → refuse
  (“requested 10 GiB”). With a naive catalog extension it would **round up to 2XL**.
- `pods/execution-preflight.ts:161-164` — `required` memory for the post-spawn metadata
  check; same 10 GiB fallback, would block an L sandbox as insufficient.
- `containers/container-memory.ts:43-63` `resolveContainerMemory` (used by
  `system-instructions-generator.ts:887-900`): sandbox null → 10 → reported as clamped to
  L; `<=0` reports the platform ceiling; instructions say “largest tier this execution
  target offers; it cannot be raised”. `validation-phase-timings.ts:73` only hashes the
  raw value (no change needed).
- `pods/environment-qualification.ts:258,344` and `pods/repair-continuation.ts:541` —
  local-Docker only flows (`launchConfig.execution.target !== 'local'` rejects at `:255`;
  infrastructure recovery is Docker-only); leave unchanged.

## 7. Messages and docs describing 4 GiB as the ceiling

- `container-memory.ts:1-9,33-42`, `sandbox-api-client.ts:308-313` comments.
- `system-instructions-generator.ts:893-899` text (“largest tier”, “caps at”).
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift:1829-1880`
  legacy profile editor: `maxSandboxMemoryGb = 4`, clamp notice, help text.
- `docs/azure-container-apps-sandboxes.md:313` only `export AZURE_SANDBOX_TIER=L`; no tier
  table or large-repo example. `docs/decisions/ADR-031…:51` lists the env var.
- `packages/daemon/CLAUDE.md:297` mentions `pickSandboxTier`.
- Spikes/scripts (`spikes/aca-sandbox/*`, `scripts/smoke-*.mjs`) are diagnostic tooling with
  their own tier tables; out of scope.

## 8. Desktop pickers and preview

All read `capabilities.execution[target]` as untyped `ConfigurationJSON`:

- `Views/Profiles/ConfigurationCollectionEditors.swift:122-152`
  `ProfileExecutionDefaultsEditor` — Memory picker from `memoryTiersGb`, labels “N GB”.
- `Views/Creation/LaunchConfigurationEditor.swift:205-212` and
  `Views/Creation/ComposableCreatePodSheet.swift:395-402` — launch override pickers, “N GB”.
- Preview/summary: `ComposableCreatePodSheet.swift:292` (“model · target · N GB · intent”),
  `LaunchComposerSupport.swift:156-160` `value(.execution)` (“Hosted sandbox · N GB”),
  `EffectiveLaunchPreview.memoryGb` (`AutopodClient/Types/LaunchConfigurationTypes.swift:195`).
- Fixtures: `AutopodDesktop/Views/DesktopConfigurationFixtures.swift:178`;
  tests `Tests/AutopodUITests/LaunchComposerTests.swift:379` (capabilities fixture),
  `:77-89` (`LaunchComposerContext` summary test).
- CLI: `ap run --memory-gb` (`packages/cli/src/commands/launch.ts:390`) passes through to
  the same resolver.

## 9. Constraints from the brief

- Another pod edits `pods/repository-preparation.ts`, Docker container-manager archive
  methods and provider continuation; avoid them.
- No DB migration is required: the choice is persisted in `resolvedExecution.main.memoryGb`.
- No cloud calls; Azure behavior is exercised with mocked `fetch`.
